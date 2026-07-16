import { describe, expect, it } from "vitest";
import {
  E164Schema,
  KapsoConfigSchema,
  resolveKapsoConfig,
  type KapsoConfig,
} from "./kapso-config.js";

const FULL: KapsoConfig = KapsoConfigSchema.parse({
  apiKey: "kapso_key",
  baseUrl: "https://api.kapso.ai/whatsapp",
  phoneNumberId: "PN_123",
  appSecret: "app_secret",
});
const NO_ENV: NodeJS.ProcessEnv = {};

describe("E164Schema", () => {
  it("accepts/rejects correctly", () => {
    expect(E164Schema.safeParse("+15550001234").success).toBe(true);
    expect(E164Schema.safeParse("15550001234").success).toBe(false);
  });
});

describe("KapsoConfigSchema", () => {
  it("defaults inbound to 'pairing' and allowFrom to []", () => {
    const c = KapsoConfigSchema.parse({});
    expect(c.inbound).toBe("pairing");
    expect(c.allowFrom).toEqual([]);
  });
  it("is strict — rejects unknown keys", () => {
    expect(KapsoConfigSchema.safeParse({ apikey: "x" }).success).toBe(false);
  });
  it("validates baseUrl as a URL and allowFrom as E.164", () => {
    expect(KapsoConfigSchema.safeParse({ baseUrl: "not-a-url" }).success).toBe(false);
    expect(KapsoConfigSchema.safeParse({ allowFrom: ["not-e164"] }).success).toBe(false);
  });
});

describe("resolveKapsoConfig — fail-closed credential completeness", () => {
  it("resolves when every credential is present", () => {
    const r = resolveKapsoConfig(FULL, NO_ENV);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      apiKey: "kapso_key",
      baseUrl: "https://api.kapso.ai/whatsapp",
      phoneNumberId: "PN_123",
      appSecret: "app_secret",
      inbound: "pairing",
    });
  });

  it("returns null (INERT) for undefined config + empty env", () => {
    expect(resolveKapsoConfig(undefined, NO_ENV)).toBeNull();
  });

  it("returns null when ANY single credential is missing (no partial wiring)", () => {
    for (const missing of ["apiKey", "baseUrl", "phoneNumberId", "appSecret"] as const) {
      const partial = { ...FULL, [missing]: undefined } as KapsoConfig;
      expect(resolveKapsoConfig(partial, NO_ENV), `missing ${missing}`).toBeNull();
    }
  });

  it("REQUIRES appSecret — an inbound channel with no x-hub-signature-256 key must not run", () => {
    const noSecret = { ...FULL, appSecret: undefined } as KapsoConfig;
    expect(resolveKapsoConfig(noSecret, NO_ENV)).toBeNull();
  });

  it("falls back to env (Infisical channels/kapso → runtime env)", () => {
    const env: NodeJS.ProcessEnv = {
      KAPSO_API_KEY: "key_env",
      KAPSO_BASE_URL: "https://api.kapso.ai/whatsapp",
      KAPSO_PHONE_NUMBER_ID: "PN_env",
      KAPSO_APP_SECRET: "secret_env",
    };
    const r = resolveKapsoConfig(KapsoConfigSchema.parse({}), env);
    expect(r).not.toBeNull();
    expect(r?.apiKey).toBe("key_env");
    expect(r?.phoneNumberId).toBe("PN_env");
  });

  it("config takes precedence over env per-field", () => {
    const env: NodeJS.ProcessEnv = { KAPSO_PHONE_NUMBER_ID: "PN_env" };
    const r = resolveKapsoConfig(FULL, env);
    expect(r?.phoneNumberId).toBe("PN_123"); // config wins
  });
});
