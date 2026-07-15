import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { listSmsAccountIds, resolveSmsAccount, SMS_CHANNEL_ID } from "./accounts.js";

const NO_ENV: NodeJS.ProcessEnv = {};
const FULL = {
  accountSid: "AC_x",
  apiKeySid: "SK_x",
  apiKeySecret: "secret_x",
  authToken: "authtok_x",
  smsNumber: "+15550001234",
};

function cfg(sms?: unknown): OpenClawConfig {
  return { channels: sms === undefined ? {} : { [SMS_CHANNEL_ID]: sms } } as OpenClawConfig;
}

describe("resolveSmsAccount — OpenClawConfig → resolveTwilioSmsConfig bridge", () => {
  it("resolves a credential-complete config section (configured=true)", () => {
    const acc = resolveSmsAccount(cfg(FULL), null, NO_ENV);
    expect(acc.configured).toBe(true);
    expect(acc.config?.smsNumber).toBe("+15550001234");
  });

  it("is INERT (configured=false, config=null) with no config and no env", () => {
    const acc = resolveSmsAccount(cfg(undefined), null, NO_ENV);
    expect(acc.configured).toBe(false);
    expect(acc.config).toBeNull();
  });

  it("falls back to env when no config section is present", () => {
    const env: NodeJS.ProcessEnv = {
      TWILIO_ACCOUNT_SID: "AC_env",
      TWILIO_API_KEY_SID: "SK_env",
      TWILIO_API_KEY_SECRET: "secret_env",
      TWILIO_AUTH_TOKEN: "authtok_env",
      TWILIO_SMS_NUMBER: "+15550009999",
    };
    const acc = resolveSmsAccount(cfg(undefined), null, env);
    expect(acc.configured).toBe(true);
    expect(acc.config?.accountSid).toBe("AC_env");
  });

  it("stays INERT (fail-closed) on a partially-specified config section", () => {
    const acc = resolveSmsAccount(cfg({ accountSid: "AC_x" }), null, NO_ENV);
    expect(acc.configured).toBe(false);
  });

  it("ignores an invalid config object (bad schema) and stays inert rather than throwing", () => {
    const acc = resolveSmsAccount(cfg({ smsNumber: "not-e164", extra: 1 }), null, NO_ENV);
    expect(acc.configured).toBe(false);
    expect(acc.config).toBeNull();
  });

  it("defaults the accountId when none is supplied", () => {
    const acc = resolveSmsAccount(cfg(FULL), null, NO_ENV);
    expect(acc.accountId.length).toBeGreaterThan(0);
  });
});

describe("listSmsAccountIds", () => {
  it("exposes a single default account (v1 single-account channel)", () => {
    const ids = listSmsAccountIds(cfg(FULL));
    expect(ids.length).toBe(1);
  });
});
