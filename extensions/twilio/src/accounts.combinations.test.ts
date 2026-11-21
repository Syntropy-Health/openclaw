/**
 * Every combination the SMS account resolution distinguishes, checked against
 * the documented rules (not against either implementation):
 *
 * - each of the five required values (four credentials + the sender number)
 *   comes from config, from env, from a whitespace-only env value (absent), or
 *   is absent;
 * - credentials are read from the SMS-specific env names when ANY of them is
 *   present (a coherent set), otherwise from the generic names; the sender
 *   number always comes from TWILIO_SMS_NUMBER;
 * - config wins over env;
 * - the account is configured exactly when all five are present, and otherwise
 *   lists exactly the missing env names (in credential order, then the number).
 */
import { describe, expect, it } from "vitest";
import { resolveSmsAccount } from "./accounts.js";

const CREDS = ["accountSid", "apiKeySid", "apiKeySecret", "authToken"] as const;
type Cred = (typeof CREDS)[number];
const GENERIC: Record<Cred, string> = {
  accountSid: "TWILIO_ACCOUNT_SID",
  apiKeySid: "TWILIO_API_KEY_SID",
  apiKeySecret: "TWILIO_API_KEY_SECRET",
  authToken: "TWILIO_AUTH_TOKEN",
};
const SMS: Record<Cred, string> = {
  accountSid: "TWILIO_SMS_ACCOUNT_SID",
  apiKeySid: "TWILIO_SMS_API_KEY_SID",
  apiKeySecret: "TWILIO_SMS_API_KEY_SECRET",
  authToken: "TWILIO_SMS_AUTH_TOKEN",
};
const NUMBER_ENV = "TWILIO_SMS_NUMBER";

type Source = "config" | "env" | "blank" | "absent";
const SOURCES: readonly Source[] = ["config", "env", "blank", "absent"];
type Mode = "generic" | "sms" | "sms-with-generic-decoys";
const MODES: readonly Mode[] = ["generic", "sms", "sms-with-generic-decoys"];

const cfgValue = (k: string) => (k === "smsNumber" ? "+15550001111" : `cfg-${k}`);
const envValueFor = (k: string) => (k === "smsNumber" ? "+15550002222" : `env-${k}`);

function build(sources: Record<Cred | "smsNumber", Source>, mode: Mode) {
  const sms: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  for (const k of [...CREDS, "smsNumber"] as const) {
    if (sources[k] === "config") {
      sms[k] = cfgValue(k);
    }
  }
  for (const k of CREDS) {
    const name = mode === "generic" ? GENERIC[k] : SMS[k];
    if (sources[k] === "env") {
      env[name] = envValueFor(k);
    } else if (sources[k] === "blank") {
      env[name] = "   ";
    }
    if (mode === "sms-with-generic-decoys") {
      env[GENERIC[k]] = `decoy-${k}`;
    }
  }
  if (sources.smsNumber === "env") {
    env[NUMBER_ENV] = envValueFor("smsNumber");
  } else if (sources.smsNumber === "blank") {
    env[NUMBER_ENV] = "   ";
  }
  return { cfg: { channels: { sms } }, env };
}

/** The rules above, written directly. */
function expected(env: Record<string, string>, sms: Record<string, unknown>) {
  const nonBlank = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const names = CREDS.some((k) => nonBlank(SMS[k]) !== undefined) ? SMS : GENERIC;
  const value: Record<string, string | undefined> = {};
  for (const k of CREDS) {
    value[k] = (sms[k] as string | undefined) ?? nonBlank(names[k]);
  }
  value.smsNumber = (sms.smsNumber as string | undefined) ?? nonBlank(NUMBER_ENV);
  const missing = CREDS.filter((k) => !value[k]).map((k) => names[k]);
  if (!value.smsNumber) {
    missing.push(NUMBER_ENV);
  }
  return { missing, value };
}

function* combinations(): Generator<Record<Cred | "smsNumber", Source>> {
  const keys = [...CREDS, "smsNumber"] as const;
  const total = SOURCES.length ** keys.length;
  for (let i = 0; i < total; i++) {
    let n = i;
    const out = {} as Record<Cred | "smsNumber", Source>;
    for (const k of keys) {
      out[k] = SOURCES[n % SOURCES.length]!;
      n = Math.floor(n / SOURCES.length);
    }
    yield out;
  }
}

describe("resolveSmsAccount: every source and env-name combination", () => {
  for (const mode of MODES) {
    it(`${mode}: configured exactly when all five are present; otherwise the exact missing names`, () => {
      let configuredCount = 0;
      let cases = 0;
      for (const sources of combinations()) {
        cases++;
        const { cfg, env } = build(sources, mode);
        const want = expected(env, cfg.channels.sms);
        const got = resolveSmsAccount(cfg as never, undefined, env);
        const label = `${mode} ${JSON.stringify(sources)}`;
        expect(got.missing, label).toEqual(want.missing);
        expect(got.configured, label).toBe(want.missing.length === 0);
        if (want.missing.length === 0) {
          configuredCount++;
          expect(got.config, label).toEqual({
            accountSid: want.value.accountSid,
            apiKeySid: want.value.apiKeySid,
            apiKeySecret: want.value.apiKeySecret,
            authToken: want.value.authToken,
            smsNumber: want.value.smsNumber,
            inbound: "pairing",
            allowFrom: [],
          });
        } else {
          expect(got.config, label).toBeNull();
        }
      }
      expect(cases).toBe(SOURCES.length ** 5);
      // Sanity: the grid contains both outcomes.
      expect(configuredCount).toBeGreaterThan(0);
      expect(configuredCount).toBeLessThan(cases);
    });
  }
});
