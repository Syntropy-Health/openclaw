/**
 * Per-user Syntropy token encryption at rest: app-side envelope encryption.
 *
 * Replaces Supabase Vault for the Cloud SQL move (CTO #16609 / #16611, design
 * workstreams/openclaw-chat-readiness/AND-token-store-vault-replacement.md).
 *
 * - A 256-bit data key (DEK) is stored WRAPPED by a Cloud KMS key-encryption
 *   key (KEK). It is unwrapped once at load and held only as a KeyObject.
 * - Each token is sealed with AES-256-GCM (12-byte IV, 16-byte tag), with the
 *   owning user id as additional authenticated data, so a ciphertext copied onto
 *   another user's row fails to open.
 * - The key id is an HMAC of the DEK itself, so re-wrapping the SAME DEK under a
 *   new KEK version keeps every row readable. An optional PREVIOUS DEK can be
 *   loaded for reads, so DEK rotation does not unpair everyone at once.
 * - The database never sees the DEK or the plaintext, unlike pgcrypto, which
 *   would put the key in SQL parameters and statement logs.
 *
 * Every failure is a named `TokenCipherError` and fails CLOSED. Nothing here
 * logs or embeds the token, the DEK or the wrapped DEK in an error message.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export type TokenCipherErrorCode =
  | "misconfigured" // a half-set config, or a malformed KEK name
  | "kek_unwrap_failed" // KMS refused or failed to unwrap a DEK (wrong or rotated KEK, no access)
  | "bad_dek" // an unwrapped DEK is not 32 bytes
  | "malformed" // stored value is not a well-formed v1 envelope
  | "key_mismatch" // sealed under a DEK that is not loaded
  | "tamper" // GCM authentication failed: modified ciphertext, wrong user, wrong key
  | "no_cipher" // the row is encrypted but no cipher is loaded
  | "vault_unavailable" // the row references the Vault but no Vault is available
  | "legacy_read_disabled"; // the row is unencrypted and legacy reads are switched off

export class TokenCipherError extends Error {
  readonly code: TokenCipherErrorCode;
  constructor(code: TokenCipherErrorCode, detail?: string) {
    super(`token-cipher: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "TokenCipherError";
    this.code = code;
  }
}

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const b64u = (buf: Buffer) => buf.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** A stable, non-secret id for a DEK: an HMAC under the DEK, so it survives KEK re-wraps. */
export function keyIdForDek(dek: Buffer): string {
  return createHmac("sha256", dek).update("openclaw-token-key-id/v1").digest("hex").slice(0, 12);
}

function loadKey(dek: Buffer): { id: string; key: KeyObject } {
  if (dek.length !== 32) {
    throw new TokenCipherError("bad_dek", `want 32 bytes, got ${dek.length}`);
  }
  return { id: keyIdForDek(dek), key: createSecretKey(dek) };
}

export class TokenCipher {
  /** The key id new seals use. */
  readonly keyId: string;
  readonly #current: KeyObject;
  readonly #byId: Map<string, KeyObject>;

  /** `current` seals and opens; `previous` (optional) only opens, for DEK rotation. */
  constructor(current: Buffer, previous?: Buffer) {
    const cur = loadKey(current);
    this.keyId = cur.id;
    this.#current = cur.key;
    this.#byId = new Map([[cur.id, cur.key]]);
    if (previous) {
      const prev = loadKey(previous);
      if (!this.#byId.has(prev.id)) this.#byId.set(prev.id, prev.key);
    }
  }

  /** Seal `plaintext` for `userId`. Returns `v1.<keyId>.<iv>.<tag>.<ciphertext>`. */
  seal(userId: string, plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv("aes-256-gcm", this.#current, iv, { authTagLength: TAG_BYTES });
    c.setAAD(Buffer.from(userId, "utf8"));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return [VERSION, this.keyId, b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join(".");
  }

  /** Open an envelope sealed for `userId`. Throws `TokenCipherError`; never returns a partial value. */
  open(userId: string, envelope: string): string {
    const parts = envelope.split(".");
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new TokenCipherError("malformed");
    }
    const [, kid, ivS, tagS, ctS] = parts;
    const iv = unb64u(ivS);
    const tag = unb64u(tagS);
    // Exact lengths: a short tag would make forgery cheap on runtimes that accept one.
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new TokenCipherError("malformed");
    }
    const key = this.#byId.get(kid);
    if (!key) {
      throw new TokenCipherError(
        "key_mismatch",
        `sealed under ${kid}, loaded ${[...this.#byId.keys()].join(",")}`,
      );
    }
    try {
      const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      d.setAAD(Buffer.from(userId, "utf8"));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(unb64u(ctS)), d.final()]).toString("utf8");
    } catch {
      throw new TokenCipherError("tamper");
    }
  }
}

/** Unwraps a stored (base64) wrapped DEK into raw key bytes. */
export type KeyUnwrapper = (wrappedDekB64: string) => Promise<Buffer>;

const KEK_NAME =
  /^projects\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;

/**
 * Cloud KMS unwrapper over the REST API (`projects.locations.keyRings.cryptoKeys.decrypt`).
 * `getAccessToken` is injected: production uses Application Default Credentials.
 */
export function gcpKmsUnwrapper(opts: {
  keyName: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): KeyUnwrapper {
  if (!KEK_NAME.test(opts.keyName)) {
    throw new TokenCipherError(
      "misconfigured",
      "OPENCLAW_TOKEN_KEK_NAME is not a KMS key resource name",
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  return async (wrappedDekB64) => {
    let res: Response;
    try {
      const token = await opts.getAccessToken();
      res = await doFetch(`https://cloudkms.googleapis.com/v1/${opts.keyName}:decrypt`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ciphertext: wrappedDekB64 }),
      });
    } catch (err) {
      throw new TokenCipherError("kek_unwrap_failed", err instanceof Error ? err.name : "error");
    }
    if (!res.ok) {
      throw new TokenCipherError("kek_unwrap_failed", `kms http ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as { plaintext?: string };
    if (!body.plaintext) {
      throw new TokenCipherError("kek_unwrap_failed", "kms response had no plaintext");
    }
    return Buffer.from(body.plaintext, "base64");
  };
}

export type TokenCipherConfig = {
  kekName: string;
  wrappedDek: string;
  wrappedPreviousDek?: string;
};

/**
 * Read the settings. Neither required one set → `null` (cipher store off; behaviour unchanged).
 * Exactly one set, or a malformed KEK name → `misconfigured` (fail closed: a half-configured
 * store must not silently fall back to writing tokens some other way).
 */
export function tokenCipherConfigFromEnv(env: NodeJS.ProcessEnv): TokenCipherConfig | null {
  const kekName = (env.OPENCLAW_TOKEN_KEK_NAME ?? "").trim();
  const wrappedDek = (env.OPENCLAW_TOKEN_DEK_WRAPPED ?? "").trim();
  const wrappedPreviousDek = (env.OPENCLAW_TOKEN_DEK_WRAPPED_PREVIOUS ?? "").trim();
  if (!kekName && !wrappedDek) return null;
  if (!kekName || !wrappedDek) {
    throw new TokenCipherError(
      "misconfigured",
      `${kekName ? "OPENCLAW_TOKEN_DEK_WRAPPED" : "OPENCLAW_TOKEN_KEK_NAME"} is not set`,
    );
  }
  if (!KEK_NAME.test(kekName)) {
    throw new TokenCipherError(
      "misconfigured",
      "OPENCLAW_TOKEN_KEK_NAME is not a KMS key resource name",
    );
  }
  return { kekName, wrappedDek, ...(wrappedPreviousDek ? { wrappedPreviousDek } : {}) };
}

async function unwrapOrFail(unwrap: KeyUnwrapper, wrapped: string): Promise<Buffer> {
  try {
    return await unwrap(wrapped);
  } catch (err) {
    if (err instanceof TokenCipherError) throw err;
    throw new TokenCipherError("kek_unwrap_failed");
  }
}

/** Unwrap the configured DEK(s) and build the cipher. Throws `TokenCipherError` on any failure. */
export async function loadTokenCipher(
  config: TokenCipherConfig,
  unwrap: KeyUnwrapper,
): Promise<TokenCipher> {
  const dek = await unwrapOrFail(unwrap, config.wrappedDek);
  const prev = config.wrappedPreviousDek
    ? await unwrapOrFail(unwrap, config.wrappedPreviousDek)
    : undefined;
  try {
    return new TokenCipher(dek, prev);
  } finally {
    dek.fill(0);
    prev?.fill(0);
  }
}

/** Production unwrapper: Cloud KMS with Application Default Credentials. */
export async function defaultKmsUnwrapper(kekName: string): Promise<KeyUnwrapper> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloudkms"] });
  return gcpKmsUnwrapper({
    keyName: kekName,
    getAccessToken: async () => {
      const t = await auth.getAccessToken();
      if (!t) throw new TokenCipherError("kek_unwrap_failed", "no access token");
      return t;
    },
  });
}

let envCipher: Promise<TokenCipher | null> | undefined;

/**
 * The cipher from env, loaded once per module instance (a jiti deep import may give a
 * second instance and a second KMS call, which is harmless). `null` when not configured.
 * A failed load is NOT cached: it rejects with the named error each time it is asked,
 * so callers fail closed and the error stays loud.
 */
export function tokenCipherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TokenCipher | null> {
  if (!envCipher) {
    envCipher = (async () => {
      const config = tokenCipherConfigFromEnv(env);
      if (!config) return null;
      return loadTokenCipher(config, await defaultKmsUnwrapper(config.kekName));
    })();
    envCipher.catch(() => {
      envCipher = undefined;
    });
  }
  return envCipher;
}

/**
 * Whether unencrypted (Vault / legacy plaintext) rows may still be READ while a cipher is
 * loaded. On for the one dual-read release (default); set OPENCLAW_TOKEN_LEGACY_READ=0 once
 * every row is ciphertext, which closes the downgrade path (a DB writer clearing the
 * ciphertext and planting a token in an older column).
 */
export function legacyReadsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENCLAW_TOKEN_LEGACY_READ ?? "1").trim() !== "0";
}

/** Test seam only. */
export function __resetTokenCipherFromEnvForTest(): void {
  envCipher = undefined;
}
