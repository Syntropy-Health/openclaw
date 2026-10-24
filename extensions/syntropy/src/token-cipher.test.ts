import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  gcpKmsUnwrapper,
  keyIdForDek,
  legacyReadsAllowed,
  loadTokenCipher,
  TokenCipher,
  TokenCipherError,
  tokenCipherConfigFromEnv,
} from "./token-cipher.js";

const TOKEN = "sj_shortpart_longsecretpart_0123456789";
const USER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const KEK =
  "projects/syntropy-sj-test/locations/us-central1/keyRings/openclaw/cryptoKeys/token-kek";

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TokenCipherError);
    expect((err as TokenCipherError).code).toBe(code);
    return err as TokenCipherError;
  }
  throw new Error(`expected TokenCipherError(${code}), got a value`);
}

/** Replace one dot-separated envelope part (base64url) with `mutate(bytes)`. */
function editPart(envelope: string, index: number, mutate: (b: Buffer) => Buffer): string {
  const parts = envelope.split(".");
  parts[index] = mutate(Buffer.from(parts[index], "base64url")).toString("base64url");
  return parts.join(".");
}

describe("TokenCipher (GREEN)", () => {
  it("round-trips a token for its user", () => {
    const cipher = new TokenCipher(randomBytes(32));
    expect(cipher.open(USER, cipher.seal(USER, TOKEN))).toBe(TOKEN);
  });

  it("the envelope carries no plaintext and each seal is unique (random IV)", () => {
    const cipher = new TokenCipher(randomBytes(32));
    const a = cipher.seal(USER, TOKEN);
    const b = cipher.seal(USER, TOKEN);
    expect(a).not.toContain(TOKEN);
    expect(a).not.toContain("sj_");
    expect(a).not.toBe(b);
    expect(a.split(".")[0]).toBe("v1");
  });

  it("the key id is derived from the DEK: the same DEK gives the same id (survives a KEK re-wrap)", () => {
    const dek = randomBytes(32);
    expect(new TokenCipher(dek).keyId).toBe(keyIdForDek(dek));
    expect(new TokenCipher(Buffer.from(dek)).keyId).toBe(new TokenCipher(dek).keyId);
    expect(new TokenCipher(randomBytes(32)).keyId).not.toBe(keyIdForDek(dek));
  });

  it("DEK rotation: rows sealed under the PREVIOUS DEK still open; new seals use the current one", () => {
    const oldDek = randomBytes(32);
    const newDek = randomBytes(32);
    const before = new TokenCipher(oldDek).seal(USER, TOKEN);
    const rotated = new TokenCipher(newDek, oldDek);
    expect(rotated.open(USER, before)).toBe(TOKEN);
    expect(rotated.seal(USER, TOKEN).split(".")[1]).toBe(keyIdForDek(newDek));
  });
});

describe("TokenCipher fails CLOSED (RED arms)", () => {
  const cipher = new TokenCipher(randomBytes(32));

  it("tampered ciphertext -> tamper (GCM tag), never a value", () => {
    const env = editPart(cipher.seal(USER, TOKEN), 4, (b) => {
      b[0] ^= 0xff;
      return b;
    });
    expectCode(() => cipher.open(USER, env), "tamper");
  });

  it("tampered tag -> tamper", () => {
    const env = editPart(cipher.seal(USER, TOKEN), 3, (b) => {
      b[0] ^= 0x01;
      return b;
    });
    expectCode(() => cipher.open(USER, env), "tamper");
  });

  it("a truncated (short) auth tag or a wrong-size IV is malformed, not accepted", () => {
    const env = cipher.seal(USER, TOKEN);
    expectCode(
      () =>
        cipher.open(
          USER,
          editPart(env, 3, (b) => b.subarray(0, 4)),
        ),
      "malformed",
    );
    expectCode(
      () =>
        cipher.open(
          USER,
          editPart(env, 3, (b) => b.subarray(0, 8)),
        ),
      "malformed",
    );
    expectCode(
      () =>
        cipher.open(
          USER,
          editPart(env, 2, (b) => b.subarray(0, 8)),
        ),
      "malformed",
    );
  });

  it("a ciphertext moved onto another user's row does not open (AAD binding)", () => {
    expectCode(() => cipher.open(OTHER, cipher.seal(USER, TOKEN)), "tamper");
  });

  it("sealed under a DEK that is not loaded (rotated away) -> key_mismatch, named", () => {
    const stranger = new TokenCipher(randomBytes(32));
    const err = expectCode(() => cipher.open(USER, stranger.seal(USER, TOKEN)), "key_mismatch");
    expect(err.message).toContain(stranger.keyId);
  });

  it("an envelope that forges the loaded key id under a different DEK fails (tamper)", () => {
    const stranger = new TokenCipher(randomBytes(32));
    const parts = stranger.seal(USER, TOKEN).split(".");
    parts[1] = cipher.keyId;
    expectCode(() => cipher.open(USER, parts.join(".")), "tamper");
  });

  it("malformed envelopes -> malformed", () => {
    for (const bad of ["", "plaintext", "v2.a.b.c.d", "v1.a.b.c"]) {
      expectCode(() => cipher.open(USER, bad), "malformed");
    }
  });

  it("a DEK that is not 32 bytes is refused", () => {
    expectCode(() => new TokenCipher(randomBytes(16)), "bad_dek");
    expectCode(() => new TokenCipher(randomBytes(32), randomBytes(16)), "bad_dek");
  });
});

describe("config from env", () => {
  it("neither setting -> null (store off, behaviour unchanged)", () => {
    expect(tokenCipherConfigFromEnv({})).toBeNull();
    expect(
      tokenCipherConfigFromEnv({ OPENCLAW_TOKEN_KEK_NAME: " ", OPENCLAW_TOKEN_DEK_WRAPPED: "" }),
    ).toBeNull();
  });

  it("exactly one setting -> misconfigured, naming the missing one", () => {
    const e1 = expectCode(
      () => tokenCipherConfigFromEnv({ OPENCLAW_TOKEN_KEK_NAME: KEK }),
      "misconfigured",
    );
    expect(e1.message).toContain("OPENCLAW_TOKEN_DEK_WRAPPED");
    const e2 = expectCode(
      () => tokenCipherConfigFromEnv({ OPENCLAW_TOKEN_DEK_WRAPPED: "abc" }),
      "misconfigured",
    );
    expect(e2.message).toContain("OPENCLAW_TOKEN_KEK_NAME");
  });

  it("RED: a KEK name that is not a KMS key resource name is refused (no path tricks in the KMS URL)", () => {
    for (const bad of [
      "projects/p/k",
      `${KEK}/../../x`,
      `${KEK}?alt=media`,
      `${KEK}#f`,
      "https://evil/x",
    ]) {
      expectCode(
        () =>
          tokenCipherConfigFromEnv({
            OPENCLAW_TOKEN_KEK_NAME: bad,
            OPENCLAW_TOKEN_DEK_WRAPPED: "abc",
          }),
        "misconfigured",
      );
    }
  });

  it("both settings -> config, with the optional previous DEK", () => {
    expect(
      tokenCipherConfigFromEnv({ OPENCLAW_TOKEN_KEK_NAME: KEK, OPENCLAW_TOKEN_DEK_WRAPPED: "abc" }),
    ).toEqual({
      kekName: KEK,
      wrappedDek: "abc",
    });
    expect(
      tokenCipherConfigFromEnv({
        OPENCLAW_TOKEN_KEK_NAME: KEK,
        OPENCLAW_TOKEN_DEK_WRAPPED: "abc",
        OPENCLAW_TOKEN_DEK_WRAPPED_PREVIOUS: "old",
      }),
    ).toEqual({ kekName: KEK, wrappedDek: "abc", wrappedPreviousDek: "old" });
  });

  it("legacy reads default ON (dual-read release) and can be switched OFF", () => {
    expect(legacyReadsAllowed({})).toBe(true);
    expect(legacyReadsAllowed({ OPENCLAW_TOKEN_LEGACY_READ: "0" })).toBe(false);
  });
});

describe("loadTokenCipher", () => {
  const config = { kekName: KEK, wrappedDek: "d3JhcHBlZA==" };

  it("GREEN: unwraps, builds a cipher keyed by the DEK, and zeroes the unwrapped buffer", async () => {
    const dek = randomBytes(32);
    const handed = Buffer.from(dek);
    const cipher = await loadTokenCipher(config, async () => handed);
    expect(cipher.keyId).toBe(keyIdForDek(dek));
    expect(handed.every((b) => b === 0)).toBe(true);
    expect(cipher.open(USER, new TokenCipher(dek).seal(USER, TOKEN))).toBe(TOKEN);
  });

  it("GREEN: loads the previous DEK too, so pre-rotation rows open", async () => {
    const cur = randomBytes(32);
    const prev = randomBytes(32);
    const old = new TokenCipher(prev).seal(USER, TOKEN);
    const cipher = await loadTokenCipher({ ...config, wrappedPreviousDek: "cHJldg==" }, async (w) =>
      Buffer.from(w === config.wrappedDek ? cur : prev),
    );
    expect(cipher.open(USER, old)).toBe(TOKEN);
  });

  it("RED: a KEK that refuses (wrong, rotated or no access) -> kek_unwrap_failed, named", async () => {
    await expect(
      loadTokenCipher(config, async () => {
        throw new Error("PERMISSION_DENIED");
      }),
    ).rejects.toMatchObject({ name: "TokenCipherError", code: "kek_unwrap_failed" });
  });

  it("RED: an unwrap that yields the wrong size -> bad_dek", async () => {
    await expect(loadTokenCipher(config, async () => randomBytes(16))).rejects.toMatchObject({
      code: "bad_dek",
    });
  });
});

describe("gcpKmsUnwrapper", () => {
  const ACCESS = "ya29.ACCESS-TOKEN-VALUE";

  it("posts the wrapped DEK to the KMS decrypt endpoint with the bearer, returns the key", async () => {
    const dek = randomBytes(32);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://cloudkms.googleapis.com/v1/${KEK}:decrypt`);
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);
      expect(JSON.parse(init.body as string)).toEqual({ ciphertext: "WRAPPED" });
      return new Response(JSON.stringify({ plaintext: dek.toString("base64") }), { status: 200 });
    });
    const unwrap = gcpKmsUnwrapper({
      keyName: KEK,
      getAccessToken: async () => ACCESS,
      fetchImpl: fetchImpl as never,
    });
    expect((await unwrap("WRAPPED")).equals(dek)).toBe(true);
  });

  it("RED: refuses to build for a key name that is not a KMS resource", () => {
    expectCode(
      () => gcpKmsUnwrapper({ keyName: `${KEK}/../../other`, getAccessToken: async () => ACCESS }),
      "misconfigured",
    );
  });

  it("RED: a KMS 403 fails closed with the status and never the access token or the blob", async () => {
    const unwrap = gcpKmsUnwrapper({
      keyName: KEK,
      getAccessToken: async () => ACCESS,
      fetchImpl: (async () => new Response("denied", { status: 403 })) as never,
    });
    const err = await unwrap("WRAPPED-BLOB").catch((e) => e);
    expect(err).toMatchObject({ code: "kek_unwrap_failed" });
    expect(err.message).toContain("403");
    expect(err.message).not.toContain(ACCESS);
    expect(err.message).not.toContain("WRAPPED-BLOB");
  });

  it("RED: a 200 without plaintext, or a network error, fails closed", async () => {
    const empty = gcpKmsUnwrapper({
      keyName: KEK,
      getAccessToken: async () => ACCESS,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as never,
    });
    await expect(empty("x")).rejects.toMatchObject({ code: "kek_unwrap_failed" });
    const boom = gcpKmsUnwrapper({
      keyName: KEK,
      getAccessToken: async () => ACCESS,
      fetchImpl: (async () => {
        throw new TypeError(`fetch failed ${ACCESS}`);
      }) as never,
    });
    const err = await boom("x").catch((e) => e);
    expect(err).toMatchObject({ code: "kek_unwrap_failed" });
    expect(err.message).not.toContain(ACCESS);
  });
});

describe("no secret in any error message (log arm)", () => {
  it("errors from every failure path carry neither the token nor the DEK", () => {
    const dek = randomBytes(32);
    const cipher = new TokenCipher(dek);
    const messages: string[] = [];
    const grab = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        messages.push(String((e as Error).message));
      }
    };
    const env = cipher.seal(USER, TOKEN);
    grab(() => cipher.open(OTHER, env));
    grab(() => new TokenCipher(randomBytes(32)).open(USER, env));
    grab(() => cipher.open(USER, "v1.kid.AAAA.BBBB.CCCC"));
    expect(messages.length).toBe(3);
    for (const m of messages) {
      expect(m).not.toContain(TOKEN);
      for (const enc of ["base64", "hex", "base64url"] as const) {
        expect(m).not.toContain(dek.toString(enc));
      }
    }
  });
});
