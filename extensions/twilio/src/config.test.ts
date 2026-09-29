import { describe, expect, it } from "vitest";
import {
  E164Schema,
  missingSmsCredentials,
  resolveTwilioSmsConfig,
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

describe("resolveTwilioSmsConfig — SMS-specific env set (voice-call shares the generic names)", () => {
  // voice-call reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN too. The ShrineAI SMS
  // number lives on a DIFFERENT Twilio account, so SMS creds must be settable
  // without re-pointing voice. TWILIO_SMS_* win as a COHERENT SET: if any SMS-
  // specific credential is present, the generic ones are ignored entirely, so
  // two accounts can never be mixed into one (unauthenticatable) config.
  const GENERIC = {
    TWILIO_ACCOUNT_SID: "AC_voice",
    TWILIO_API_KEY_SID: "SK_voice",
    TWILIO_API_KEY_SECRET: "secret_voice",
    TWILIO_AUTH_TOKEN: "authtok_voice",
  };
  const SMS = {
    TWILIO_SMS_ACCOUNT_SID: "AC_sms",
    TWILIO_SMS_API_KEY_SID: "SK_sms",
    TWILIO_SMS_API_KEY_SECRET: "secret_sms",
    TWILIO_SMS_AUTH_TOKEN: "authtok_sms",
  };

  it("uses the TWILIO_SMS_* credentials when present, even with generic ones set", () => {
    const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), {
      ...GENERIC,
      ...SMS,
      TWILIO_SMS_NUMBER: "+15550008434",
    });
    expect(r).toMatchObject({
      accountSid: "AC_sms",
      apiKeySid: "SK_sms",
      apiKeySecret: "secret_sms",
      authToken: "authtok_sms",
      smsNumber: "+15550008434",
    });
  });

  it("never MIXES accounts: a partial SMS-specific set is INERT, not topped up from generic", () => {
    const { TWILIO_SMS_API_KEY_SECRET: _drop, ...partial } = SMS;
    const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), {
      ...GENERIC,
      ...partial,
      TWILIO_SMS_NUMBER: "+15550008434",
    });
    expect(r).toBeNull();
  });

  it("with NO SMS-specific credentials, the generic names still work (documented fallback)", () => {
    const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), {
      ...GENERIC,
      TWILIO_SMS_NUMBER: "+15550009999",
    });
    expect(r?.accountSid).toBe("AC_voice");
  });

  it("ONE SMS-specific credential alone selects the SMS set (inert), never tops up from generic", () => {
    const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), {
      ...GENERIC,
      TWILIO_SMS_ACCOUNT_SID: "AC_sms",
      TWILIO_SMS_NUMBER: "+15550008434",
    });
    expect(r).toBeNull();
  });

  it.each(["", "   ", "\n"])(
    "an empty/whitespace SMS-specific value (%j) counts as ABSENT: generic still works",
    (blank) => {
      const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), {
        ...GENERIC,
        TWILIO_SMS_ACCOUNT_SID: blank,
        TWILIO_SMS_NUMBER: "+15550009999",
      });
      expect(r?.accountSid).toBe("AC_voice");
    },
  );

  it("a whitespace-only credential does NOT satisfy the set (inert, not a blank password)", () => {
    const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), {
      ...SMS,
      TWILIO_SMS_API_KEY_SECRET: "  ",
      TWILIO_SMS_NUMBER: "+15550008434",
    });
    expect(r).toBeNull();
  });

  it("values are trimmed (a secret store's trailing newline does not break auth)", () => {
    const r = resolveTwilioSmsConfig(TwilioSmsConfigSchema.parse({}), {
      ...SMS,
      TWILIO_SMS_AUTH_TOKEN: "authtok_sms\n",
      TWILIO_SMS_NUMBER: " +15550008434 ",
    });
    expect(r?.authToken).toBe("authtok_sms");
    expect(r?.smsNumber).toBe("+15550008434");
  });
});

describe("missingSmsCredentials — names what an enabled-but-inert surface needs", () => {
  const SMS_SET = {
    TWILIO_SMS_ACCOUNT_SID: "AC_sms",
    TWILIO_SMS_API_KEY_SID: "SK_sms",
    TWILIO_SMS_API_KEY_SECRET: "secret_sms",
    TWILIO_SMS_AUTH_TOKEN: "authtok_sms",
  };
  it("nothing set: names the generic set + the number", () => {
    expect(missingSmsCredentials(undefined, {})).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_API_KEY_SID",
      "TWILIO_API_KEY_SECRET",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_SMS_NUMBER",
    ]);
  });
  it("a partial SMS set: names the SMS-specific names still missing", () => {
    const { TWILIO_SMS_AUTH_TOKEN: _d, ...partial } = SMS_SET;
    expect(
      missingSmsCredentials(undefined, { ...partial, TWILIO_SMS_NUMBER: "+15550008434" }),
    ).toEqual(["TWILIO_SMS_AUTH_TOKEN"]);
  });
  it("complete: empty, and it returns names, never values", () => {
    expect(
      missingSmsCredentials(undefined, { ...SMS_SET, TWILIO_SMS_NUMBER: "+15550008434" }),
    ).toEqual([]);
    const out = missingSmsCredentials(undefined, { TWILIO_SMS_ACCOUNT_SID: "AC_secretish" }).join(
      " ",
    );
    expect(out).not.toContain("AC_secretish");
  });
});
