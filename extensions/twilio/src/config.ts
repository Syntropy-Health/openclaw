/**
 * Twilio channel config (B-Twilio-1, SMS first) — the auth + number contract.
 *
 * Per AD-onboarding-channels §4.2 (CTO-gated): Twilio has NO OAuth for its core
 * REST API, so we use SCOPED STANDARD API KEYS (SID + Secret) on PER-ENV
 * SUBACCOUNTS — NEVER the master Auth Token. Test/prod isolation is by
 * construction (separate subaccount SIDs, numbers, WABA senders).
 *
 * - REST sending (SMS) authenticates with the API Key: basic-auth
 *   `apiKeySid:apiKeySecret` against the subaccount's `accountSid`.
 * - Inbound webhook `X-Twilio-Signature` validation (§4.3) needs the SUBACCOUNT
 *   Auth Token (the HMAC key) — the one place an Auth Token is required; it is
 *   the subaccount's, never the master account's.
 *
 * Secrets are Infisical-first under `channels/twilio/{env}/…` and read into env
 * at runtime; never committed, never in a message/URL. Every field is optional +
 * env-fallback so the channel stays INERT (registers nothing) until provisioned.
 */

import { z } from "zod";

/** E.164 phone number (`+[country][number]`). 555-prefixed examples are fictional. */
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

/**
 * SMS inbound policy — how inbound messages from unknown numbers are treated.
 * `pairing` routes an unpaired number to the connect CTA (deny-by-default posture
 * mirrors the gateway's SYNTROPY_GATE); `allowlist` restricts to `allowFrom`.
 */
export const TwilioInboundPolicySchema = z.enum(["disabled", "allowlist", "pairing"]);
export type TwilioInboundPolicy = z.infer<typeof TwilioInboundPolicySchema>;

export const TwilioSmsConfigSchema = z
  .object({
    /** Subaccount Account SID (`AC…`) — the per-env subaccount, not the master. */
    accountSid: z.string().min(1).optional(),
    /** Standard API Key SID (`SK…`) — scoped, independently revocable. */
    apiKeySid: z.string().min(1).optional(),
    /** Standard API Key Secret — paired with apiKeySid for REST basic-auth. */
    apiKeySecret: z.string().min(1).optional(),
    /**
     * Subaccount Auth Token — required ONLY as the HMAC key for X-Twilio-Signature
     * webhook validation (§4.3). The subaccount's, never the master's. Not used
     * for REST auth (the API key is).
     */
    authToken: z.string().min(1).optional(),
    /** The E.164 SMS sender number provisioned on this subaccount. */
    smsNumber: E164Schema.optional(),
    /** Inbound handling. Default `pairing` (unpaired → connect CTA, deny-by-default). */
    inbound: TwilioInboundPolicySchema.default("pairing"),
    /** E.164 numbers accepted when `inbound: "allowlist"`. */
    allowFrom: z.array(E164Schema).default([]),
  })
  .strict();
export type TwilioSmsConfig = z.infer<typeof TwilioSmsConfigSchema>;

/** Resolved, credential-complete config — the shape the transport requires to run. */
export type ResolvedTwilioSmsConfig = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  authToken: string;
  smsNumber: string;
  inbound: TwilioInboundPolicy;
  allowFrom: readonly string[];
};

/** Env-var names (Infisical `channels/twilio/{env}` → runtime env). */
const ENV = {
  accountSid: "TWILIO_ACCOUNT_SID",
  apiKeySid: "TWILIO_API_KEY_SID",
  apiKeySecret: "TWILIO_API_KEY_SECRET",
  authToken: "TWILIO_AUTH_TOKEN",
  smsNumber: "TWILIO_SMS_NUMBER",
} as const;

/**
 * SMS-specific credential names. voice-call reads the GENERIC TWILIO_ACCOUNT_SID /
 * TWILIO_AUTH_TOKEN, and the ShrineAI SMS number can live on a different Twilio
 * account, so SMS credentials must be settable without re-pointing voice.
 * They win as a COHERENT SET: if ANY of these is present, the generic names are
 * ignored for credentials, so two accounts are never mixed into one config.
 */
const SMS_ENV = {
  accountSid: "TWILIO_SMS_ACCOUNT_SID",
  apiKeySid: "TWILIO_SMS_API_KEY_SID",
  apiKeySecret: "TWILIO_SMS_API_KEY_SECRET",
  authToken: "TWILIO_SMS_AUTH_TOKEN",
} as const;

/** An env value, trimmed; empty or whitespace-only counts as ABSENT (a secret store
 * that writes "" or a stray newline must not select a credential set or satisfy one). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

type CredentialNames = { [K in keyof typeof SMS_ENV]: string };

/** Which env names the credentials are read from: the SMS set if ANY of it is present. */
function credentialEnvNames(env: NodeJS.ProcessEnv): CredentialNames {
  const smsPresent = Object.values(SMS_ENV).some((n) => envValue(env, n) !== undefined);
  return smsPresent ? SMS_ENV : ENV;
}

function envCredentials(env: NodeJS.ProcessEnv) {
  const names = credentialEnvNames(env);
  return {
    accountSid: envValue(env, names.accountSid),
    apiKeySid: envValue(env, names.apiKeySid),
    apiKeySecret: envValue(env, names.apiKeySecret),
    authToken: envValue(env, names.authToken),
  };
}

/**
 * The credential/number env NAMES still missing for SMS to run — names only, never
 * values — so an enabled-but-inert surface can say exactly what to provision.
 * Empty when the config is credential-complete.
 */
export function missingSmsCredentials(
  input: TwilioSmsConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const parsed = input ?? TwilioSmsConfigSchema.parse({});
  const names = credentialEnvNames(env);
  const fromEnv = envCredentials(env);
  const missing: string[] = [];
  // Iterate the CREDENTIAL keys only: the generic name map also has smsNumber.
  for (const k of Object.keys(SMS_ENV) as Array<keyof CredentialNames>) {
    if (!(parsed[k] ?? fromEnv[k])) missing.push(names[k]);
  }
  if (!(parsed.smsNumber ?? envValue(env, ENV.smsNumber))) missing.push(ENV.smsNumber);
  return missing;
}

/**
 * Merge config + env fallback and decide whether the SMS channel is CREDENTIAL-
 * COMPLETE. Returns the resolved config only when EVERY required credential +
 * the sender number is present — otherwise `null` (channel stays INERT, registers
 * nothing). This is the fail-closed "no partial Twilio wiring" gate: a half-set
 * config never half-activates.
 *
 * The `authToken` (webhook-signature key) is REQUIRED here: an SMS channel with no
 * way to validate inbound `X-Twilio-Signature` must not run (§4.3 non-negotiable).
 */
export function resolveTwilioSmsConfig(
  input: TwilioSmsConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTwilioSmsConfig | null {
  const parsed = input ?? TwilioSmsConfigSchema.parse({});
  const fromEnv = envCredentials(env);
  const accountSid = parsed.accountSid ?? fromEnv.accountSid;
  const apiKeySid = parsed.apiKeySid ?? fromEnv.apiKeySid;
  const apiKeySecret = parsed.apiKeySecret ?? fromEnv.apiKeySecret;
  const authToken = parsed.authToken ?? fromEnv.authToken;
  const smsNumber = parsed.smsNumber ?? envValue(env, ENV.smsNumber);

  if (!accountSid || !apiKeySid || !apiKeySecret || !authToken || !smsNumber) {
    return null;
  }
  return {
    accountSid,
    apiKeySid,
    apiKeySecret,
    authToken,
    smsNumber,
    inbound: parsed.inbound,
    allowFrom: parsed.allowFrom,
  };
}
