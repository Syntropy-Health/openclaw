/**
 * Per-user Syntropy token encryption at rest: app-side envelope encryption.
 *
 * Replaces Supabase Vault for the Cloud SQL move (CTO #16609 / #16611, design
 * workstreams/openclaw-chat-readiness/AND-token-store-vault-replacement.md).
 *
 * - A 256-bit data key (DEK) is stored WRAPPED by a Cloud KMS key-encryption
 *   key (KEK). It is unwrapped once at load and held only in memory.
 * - Each token is sealed with AES-256-GCM, with the owning user id as
 *   additional authenticated data, so a ciphertext copied onto another user's
 *   row fails to open.
 * - The database never sees the DEK or the plaintext, unlike pgcrypto, which
 *   would put the key in SQL parameters and statement logs.
 *
 * Every failure is a named `TokenCipherError` and fails CLOSED. Nothing here
 * logs or embeds the token, the DEK or the wrapped DEK in an error message.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type TokenCipherErrorCode =
  | "misconfigured" // exactly one of the two settings is present
  | "kek_unwrap_failed" // KMS refused or failed to unwrap the DEK (wrong or rotated KEK, no access)
  | "bad_dek" // the unwrapped DEK is not 32 bytes
  | "malformed" // stored value is not a v1 envelope
  | "key_mismatch" // sealed under a different DEK than the one loaded
  | "tamper"; // GCM authentication failed: modified ciphertext, wrong user, wrong key

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
const b64u = (buf: Buffer) => buf.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** A stable, non-secret id for a wrapped DEK: lets rotated rows coexist and be told apart. */
export function keyIdFor(wrappedDek: string): string {
  return createHash("sha256").update(wrappedDek).digest("hex").slice(0, 12);
}

export class TokenCipher {
  readonly keyId: string;
  readonly #dek: Buffer;

  constructor(dek: Buffer, keyId: string) {
    if (dek.length !== 32) {
      throw new TokenCipherError("bad_dek", `want 32 bytes, got ${dek.length}`);
    }
    this.#dek = Buffer.from(dek);
    this.keyId = keyId;
  }

  /** Seal `plaintext` for `userId`. Returns `v1.<keyId>.<iv>.<tag>.<ciphertext>`. */
  seal(userId: string, plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv("aes-256-gcm", this.#dek, iv);
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
    if (kid !== this.keyId) {
      throw new TokenCipherError("key_mismatch", `sealed under ${kid}, loaded ${this.keyId}`);
    }
    try {
      const d = createDecipheriv("aes-256-gcm", this.#dek, unb64u(ivS));
      d.setAAD(Buffer.from(userId, "utf8"));
      d.setAuthTag(unb64u(tagS));
      return Buffer.concat([d.update(unb64u(ctS)), d.final()]).toString("utf8");
    } catch {
      throw new TokenCipherError("tamper");
    }
  }
}

/** Unwraps the stored (base64) wrapped DEK into raw key bytes. */
export type KeyUnwrapper = (wrappedDekB64: string) => Promise<Buffer>;

/**
 * Cloud KMS unwrapper over the REST API (`projects.locations.keyRings.cryptoKeys.decrypt`).
 * `getAccessToken` is injected: production uses Application Default Credentials.
 */
export function gcpKmsUnwrapper(opts: {
  keyName: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): KeyUnwrapper {
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

export type TokenCipherConfig = { kekName: string; wrappedDek: string };

/**
 * Read the two settings. Neither set → `null` (cipher store off; behaviour unchanged).
 * Exactly one set → `misconfigured` (fail closed: a half-configured store must not
 * silently fall back to writing tokens some other way).
 */
export function tokenCipherConfigFromEnv(env: NodeJS.ProcessEnv): TokenCipherConfig | null {
  const kekName = (env.OPENCLAW_TOKEN_KEK_NAME ?? "").trim();
  const wrappedDek = (env.OPENCLAW_TOKEN_DEK_WRAPPED ?? "").trim();
  if (!kekName && !wrappedDek) return null;
  if (!kekName || !wrappedDek) {
    throw new TokenCipherError(
      "misconfigured",
      `${kekName ? "OPENCLAW_TOKEN_DEK_WRAPPED" : "OPENCLAW_TOKEN_KEK_NAME"} is not set`,
    );
  }
  return { kekName, wrappedDek };
}

/** Unwrap the configured DEK and build the cipher. Throws `TokenCipherError` on any failure. */
export async function loadTokenCipher(
  config: TokenCipherConfig,
  unwrap: KeyUnwrapper,
): Promise<TokenCipher> {
  let dek: Buffer;
  try {
    dek = await unwrap(config.wrappedDek);
  } catch (err) {
    if (err instanceof TokenCipherError) throw err;
    throw new TokenCipherError("kek_unwrap_failed");
  }
  try {
    return new TokenCipher(dek, keyIdFor(config.wrappedDek));
  } finally {
    dek.fill(0);
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
 * The process-wide cipher from env, loaded once. `null` when not configured.
 * A failed load is NOT cached as `null`: it rejects with the named error every
 * time, so callers fail closed and the error stays loud.
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

/** Test seam only. */
export function __resetTokenCipherFromEnvForTest(): void {
  envCipher = undefined;
}
