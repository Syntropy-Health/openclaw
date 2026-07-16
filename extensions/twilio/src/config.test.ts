import { describe, expect, it } from "vitest";
import {
  E164Schema,
  resolveTwilioSmsConfig,
  resolveTwilioWabaConfig,
  TwilioSmsConfigSchema,
  type TwilioSmsConfig,
} from "./config.js";

const FULL: TwilioSmsConfig = TwilioSmsConfigSchema.parse({
  accountSid: "AC_test",
  apiKeySid: "SK_test",
  apiKeySecret: "secret_test",
  authToken: "authtok_test",
  smsNumber: "+15550001234",
});

const NO_ENV: NodeJS.ProcessEnv = {};

describe("E164Schema", () => {
  it("accepts E.164 numbers", () => {
    for (const n of ["+15550001234", "+447700900123", "+919812345678"]) {
      expect(E164Schema.safeParse(n).success, n).toBe(true);
    }
  });
  it("rejects non-E.164 (no +, leading 0, letters, spaces)", () => {
    for (const n of ["5550001234", "+05550001234", "+1 555 000 1234", "+abc"]) {
      expect(E164Schema.safeParse(n).success, n).toBe(false);
    }
  });
});

describe("TwilioSmsConfigSchema", () => {
  it("defaults inbound to 'pairing' (deny-by-default) and allowFrom to []", () => {
    const c = TwilioSmsConfigSchema.parse({});
    expect(c.inbound).toBe("pairing");
    expect(c.allowFrom).toEqual([]);
  });
  it("is strict — rejects unknown keys (typo-safety)", () => {
    expect(TwilioSmsConfigSchema.safeParse({ acountSid: "AC" }).success).toBe(false);
  });
  it("validates allowFrom entries as E.164", () => {
    expect(TwilioSmsConfigSchema.safeParse({ allowFrom: ["not-e164"] }).success).toBe(false);
    expect(TwilioSmsConfigSchema.safeParse({ allowFrom: ["+15550001234"] }).success).toBe(true);
  });
});

describe("resolveTwilioSmsConfig — fail-closed credential completeness", () => {
  it("returns the resolved config when every credential + number is present (config)", () => {
    const r = resolveTwilioSmsConfig(FULL, NO_ENV);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      accountSid: "AC_test",
      apiKeySid: "SK_test",
      apiKeySecret: "secret_test",
      authToken: "authtok_test",
      smsNumber: "+15550001234",
      inbound: "pairing",
    });
  });

  it("returns null (INERT) for undefined config + empty env", () => {
    expect(resolveTwilioSmsConfig(undefined, NO_ENV)).toBeNull();
  });

  it("returns null when ANY single credential is missing (no partial wiring)", () => {
    const keys = ["accountSid", "apiKeySid", "apiKeySecret", "authToken", "smsNumber"] as const;
    for (const missing of keys) {
      const partial = { ...FULL, [missing]: undefined } as TwilioSmsConfig;
      expect(resolveTwilioSmsConfig(partial, NO_ENV), `missing ${missing}`).toBeNull();
    }
  });

  it("REQUIRES authToken — an SMS channel with no X-Twilio-Signature key must not run (§4.3)", () => {
    const noAuth = { ...FULL, authToken: undefined } as TwilioSmsConfig;
    expect(resolveTwilioSmsConfig(noAuth, NO_ENV)).toBeNull();
  });

  it("falls back to env (Infisical channels/twilio → runtime env)", () => {
    const env: NodeJS.ProcessEnv = {
      TWILIO_ACCOUNT_SID: "AC_env",
      TWILIO_API_KEY_SID: "SK_env",
      TWILIO_API_KEY_SECRET: "secret_env",
      TWILIO_AUTH_TOKEN: "authtok_env",
      TWILIO_SMS_NUMBER: "+15550009999",
    };
    const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), env);
    expect(r).not.toBeNull();
    expect(r?.accountSid).toBe("AC_env");
    expect(r?.smsNumber).toBe("+15550009999");
  });

  it("config takes precedence over env per-field", () => {
    const env: NodeJS.ProcessEnv = { TWILIO_SMS_NUMBER: "+15550000000" };
    const r = resolveTwilioSmsConfig(FULL, env);
    expect(r?.smsNumber).toBe("+15550001234"); // config wins
  });
});

describe("resolveTwilioWabaConfig — WhatsApp sender, same fail-closed gate", () => {
  const WABA_FULL = TwilioSmsConfigSchema.parse({
    accountSid: "AC_test",
    apiKeySid: "SK_test",
    apiKeySecret: "secret_test",
    authToken: "authtok_test",
    whatsappNumber: "+15550005678",
  });

  it("resolves when shared creds + the WABA sender are present", () => {
    const r = resolveTwilioWabaConfig(WABA_FULL, NO_ENV);
    expect(r).not.toBeNull();
    expect(r?.whatsappNumber).toBe("+15550005678");
    expect(r).not.toHaveProperty("smsNumber"); // WABA config is keyed on whatsappNumber
  });

  it("is INERT (null) when whatsappNumber is missing even with all SMS creds present", () => {
    expect(resolveTwilioWabaConfig(FULL, NO_ENV)).toBeNull(); // FULL has smsNumber, no whatsappNumber
  });

  it("returns null when ANY shared credential is missing (no partial wiring)", () => {
    for (const missing of ["accountSid", "apiKeySid", "apiKeySecret", "authToken"] as const) {
      const partial = { ...WABA_FULL, [missing]: undefined } as TwilioSmsConfig;
      expect(resolveTwilioWabaConfig(partial, NO_ENV), `missing ${missing}`).toBeNull();
    }
  });

  it("falls back to env (TWILIO_WHATSAPP_NUMBER)", () => {
    const env: NodeJS.ProcessEnv = {
      TWILIO_ACCOUNT_SID: "AC_env",
      TWILIO_API_KEY_SID: "SK_env",
      TWILIO_API_KEY_SECRET: "secret_env",
      TWILIO_AUTH_TOKEN: "authtok_env",
      TWILIO_WHATSAPP_NUMBER: "+15550009999",
    };
    const r = resolveTwilioWabaConfig(TwilioSmsConfigSchema.parse({}), env);
    expect(r?.whatsappNumber).toBe("+15550009999");
  });
});
