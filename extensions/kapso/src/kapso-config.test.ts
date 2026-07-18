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

  it("returns null when ANY required credential is missing (apiKey/phoneNumberId/appSecret)", () => {
    for (const missing of ["apiKey", "phoneNumberId", "appSecret"] as const) {
      const partial = { ...FULL, [missing]: undefined } as KapsoConfig;
      expect(resolveKapsoConfig(partial, NO_ENV), `missing ${missing}`).toBeNull();
    }
  });

  it("defaults baseUrl to the Kapso Meta-proxy host when not provided", () => {
    const noBaseUrl = { ...FULL, baseUrl: undefined } as KapsoConfig;
    const r = resolveKapsoConfig(noBaseUrl, NO_ENV);
    expect(r).not.toBeNull();
    expect(r?.baseUrl).toBe("https://api.kapso.ai/meta/whatsapp/v24.0");
  });

  it("resolves with businessAccountId and NO explicit phoneNumberId (derived later via lookup)", () => {
    const noPn = KapsoConfigSchema.parse({
      apiKey: "k",
      appSecret: "s",
      businessAccountId: "1312147934010664",
    });
    const r = resolveKapsoConfig(noPn, NO_ENV);
    expect(r).not.toBeNull();
    expect(r?.phoneNumberId).toBeUndefined();
    expect(r?.businessAccountId).toBe("1312147934010664");
  });

  it("stays INERT when neither phoneNumberId nor businessAccountId is present", () => {
    const noTarget = KapsoConfigSchema.parse({ apiKey: "k", appSecret: "s" });
    expect(resolveKapsoConfig(noTarget, NO_ENV)).toBeNull();
  });

  it("carries the optional context ids (businessAccountId/portfolioId/configId) through", () => {
    const withIds = KapsoConfigSchema.parse({
      ...FULL,
      businessAccountId: "1312147934010664",
      portfolioId: "282010709070165",
      configId: "46202afe-8604-4656-be52-394656c315f7",
    });
    const r = resolveKapsoConfig(withIds, NO_ENV);
    expect(r?.businessAccountId).toBe("1312147934010664");
    expect(r?.configId).toBe("46202afe-8604-4656-be52-394656c315f7");
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
