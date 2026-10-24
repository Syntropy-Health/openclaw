import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  gcpKmsUnwrapper,
  keyIdFor,
  loadTokenCipher,
  TokenCipher,
  TokenCipherError,
  tokenCipherConfigFromEnv,
} from "./token-cipher.js";

const TOKEN = "sj_shortpart_longsecretpart_0123456789";
const USER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

function cipherWith(dek = randomBytes(32), kid = "kid-a") {
  return { cipher: new TokenCipher(dek, kid), dek };
}

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

describe("TokenCipher (GREEN)", () => {
  it("round-trips a token for its user", () => {
    const { cipher } = cipherWith();
    const env = cipher.seal(USER, TOKEN);
    expect(cipher.open(USER, env)).toBe(TOKEN);
  });

  it("the envelope carries no plaintext and each seal is unique (random IV)", () => {
    const { cipher } = cipherWith();
    const a = cipher.seal(USER, TOKEN);
    const b = cipher.seal(USER, TOKEN);
    expect(a).not.toContain(TOKEN);
    expect(a).not.toContain("sj_");
    expect(a).not.toBe(b);
    expect(a.split(".")[0]).toBe("v1");
  });
});

describe("TokenCipher fails CLOSED (RED arms)", () => {
  it("tampered ciphertext -> tamper (GCM tag), never a value", () => {
    const { cipher } = cipherWith();
    const parts = cipher.seal(USER, TOKEN).split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 0xff;
    parts[4] = ct.toString("base64url");
    expectCode(() => cipher.open(USER, parts.join(".")), "tamper");
  });

  it("tampered tag -> tamper", () => {
    const { cipher } = cipherWith();
    const parts = cipher.seal(USER, TOKEN).split(".");
    const tag = Buffer.from(parts[3], "base64url");
    tag[0] ^= 0x01;
    parts[3] = tag.toString("base64url");
    expectCode(() => cipher.open(USER, parts.join(".")), "tamper");
  });

  it("a ciphertext moved onto another user's row does not open (AAD binding)", () => {
    const { cipher } = cipherWith();
    expectCode(() => cipher.open(OTHER, cipher.seal(USER, TOKEN)), "tamper");
  });

  it("sealed under a different (e.g. rotated) DEK -> key_mismatch, named", () => {
    const a = cipherWith(randomBytes(32), "kid-a").cipher;
    const b = cipherWith(randomBytes(32), "kid-b").cipher;
    const err = expectCode(() => b.open(USER, a.seal(USER, TOKEN)), "key_mismatch");
    expect(err.message).toContain("kid-a");
  });

  it("a wrong DEK presenting the same key id still fails (tamper), never a value", () => {
    const a = cipherWith(randomBytes(32), "kid-same").cipher;
    const b = cipherWith(randomBytes(32), "kid-same").cipher;
    expectCode(() => b.open(USER, a.seal(USER, TOKEN)), "tamper");
  });

  it("malformed envelopes -> malformed", () => {
    const { cipher } = cipherWith();
    for (const bad of ["", "plaintext", "v2.a.b.c.d", "v1.a.b.c"]) {
      expectCode(() => cipher.open(USER, bad), "malformed");
    }
  });

  it("a DEK that is not 32 bytes is refused", () => {
    expectCode(() => new TokenCipher(randomBytes(16), "k"), "bad_dek");
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
      () => tokenCipherConfigFromEnv({ OPENCLAW_TOKEN_KEK_NAME: "projects/p/k" }),
      "misconfigured",
    );
    expect(e1.message).toContain("OPENCLAW_TOKEN_DEK_WRAPPED");
    const e2 = expectCode(
      () => tokenCipherConfigFromEnv({ OPENCLAW_TOKEN_DEK_WRAPPED: "abc" }),
      "misconfigured",
    );
    expect(e2.message).toContain("OPENCLAW_TOKEN_KEK_NAME");
  });

  it("both settings -> config", () => {
    expect(
      tokenCipherConfigFromEnv({
        OPENCLAW_TOKEN_KEK_NAME: "projects/p/k",
        OPENCLAW_TOKEN_DEK_WRAPPED: "abc",
      }),
    ).toEqual({ kekName: "projects/p/k", wrappedDek: "abc" });
  });
});

describe("loadTokenCipher", () => {
  const config = {
    kekName: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    wrappedDek: "d3JhcHBlZA==",
  };

  it("GREEN: unwraps, builds a cipher with the derived key id, and zeroes the unwrapped buffer", async () => {
    const dek = randomBytes(32);
    const handed = Buffer.from(dek);
    const cipher = await loadTokenCipher(config, async () => handed);
    expect(cipher.keyId).toBe(keyIdFor(config.wrappedDek));
    expect(handed.every((b) => b === 0)).toBe(true);
    expect(cipher.open(USER, new TokenCipher(dek, cipher.keyId).seal(USER, TOKEN))).toBe(TOKEN);
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
  const keyName =
    "projects/syntropy-sj-test/locations/us-central1/keyRings/openclaw/cryptoKeys/token-kek";
  const ACCESS = "ya29.ACCESS-TOKEN-VALUE";

  it("posts the wrapped DEK to the KMS decrypt endpoint with the bearer, returns the key", async () => {
    const dek = randomBytes(32);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://cloudkms.googleapis.com/v1/${keyName}:decrypt`);
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);
      expect(JSON.parse(init.body as string)).toEqual({ ciphertext: "WRAPPED" });
      return new Response(JSON.stringify({ plaintext: dek.toString("base64") }), { status: 200 });
    });
    const unwrap = gcpKmsUnwrapper({
      keyName,
      getAccessToken: async () => ACCESS,
      fetchImpl: fetchImpl as never,
    });
    expect((await unwrap("WRAPPED")).equals(dek)).toBe(true);
  });

  it("RED: a KMS 403 fails closed with the status and never the access token or the blob", async () => {
    const unwrap = gcpKmsUnwrapper({
      keyName,
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
      keyName,
      getAccessToken: async () => ACCESS,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as never,
    });
    await expect(empty("x")).rejects.toMatchObject({ code: "kek_unwrap_failed" });
    const boom = gcpKmsUnwrapper({
      keyName,
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
  it("errors from every failure path carry neither the token nor the DEK", async () => {
    const dek = randomBytes(32);
    const cipher = new TokenCipher(dek, "kid");
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
    grab(() => new TokenCipher(randomBytes(32), "kid2").open(USER, env));
    grab(() => cipher.open(USER, "v1.kid.AAAA.BBBB.CCCC"));
    expect(messages.length).toBe(3);
    for (const m of messages) {
      expect(m).not.toContain(TOKEN);
      expect(m).not.toContain(dek.toString("base64"));
      expect(m).not.toContain(dek.toString("hex"));
      expect(m).not.toContain(dek.toString("base64url"));
    }
  });
});
