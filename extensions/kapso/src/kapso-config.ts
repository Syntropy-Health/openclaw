/**
 * Kapso WhatsApp config (B-Kapso-1, slice 1) — the auth + sender contract for the
 * WhatsApp Cloud API via Kapso (ADR 0002).
 *
 * Kapso is a thin layer over Meta's official WhatsApp Cloud API:
 *  - REST send authenticates with the **project API key** in the `X-API-Key`
 *    header (Kapso's Meta-proxy auth — NOT `Authorization: Bearer`) against the
 *    Kapso base URL, posting to `{baseUrl}/{phoneNumberId}/messages`.
 *  - Inbound webhook validation (slice 2) uses the **app secret** as the HMAC key
 *    for the standard Meta `x-hub-signature-256` header — the one place the app
 *    secret is used.
 *
 * Secrets are Infisical-first under `channels/kapso/{env}/…`, read into env at
 * runtime; never committed, never in a message/URL. Every field is optional +
 * env-fallback so the channel stays INERT (fail-closed) until provisioned.
 */

import { z } from "zod";

/** E.164 phone number (`+[country][number]`). */
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

/** Inbound policy — mirrors the SMS channel (deny-by-default `pairing`). */
export const KapsoInboundPolicySchema = z.enum(["disabled", "allowlist", "pairing"]);
export type KapsoInboundPolicy = z.infer<typeof KapsoInboundPolicySchema>;

export const KapsoConfigSchema = z
  .object({
    /** Kapso project API key — sent in the `X-API-Key` header for REST send. */
    apiKey: z.string().min(1).optional(),
    /** Kapso Meta-proxy base URL. Optional — resolver defaults to the documented host + version. */
    baseUrl: z.string().url().optional(),
    /** WABA sender phone-number-id (Cloud API `{phoneNumberId}/messages`, path param). */
    phoneNumberId: z.string().min(1).optional(),
    /**
     * Meta app secret — required ONLY as the HMAC key for the inbound
     * `x-hub-signature-256` webhook validation. Not used for REST auth (the API
     * key is). Sourced from the GTM Infisical project's Meta app credentials.
     */
    appSecret: z.string().min(1).optional(),
    /** WhatsApp Business Account (WABA) id — context; enables phone-number lookup. */
    businessAccountId: z.string().min(1).optional(),
    /** Meta Business Portfolio id — context. */
    portfolioId: z.string().min(1).optional(),
    /** Kapso WhatsApp config id — identifies the connection for Kapso-native ops. */
    configId: z.string().min(1).optional(),
    /** Inbound handling. Default `pairing` (unpaired → connect CTA, deny-by-default). */
    inbound: KapsoInboundPolicySchema.default("pairing"),
    /** E.164 numbers accepted when `inbound: "allowlist"`. */
    allowFrom: z.array(E164Schema).default([]),
  })
  .strict();
export type KapsoConfig = z.infer<typeof KapsoConfigSchema>;

/** Resolved, credential-complete config — the shape the transport requires to run. */
export type ResolvedKapsoConfig = {
  apiKey: string;
  baseUrl: string;
  /**
   * Explicit sender phone-number-id. Optional here: when absent it is derived at
   * runtime from `businessAccountId` (see kapso-phone.ts). The credential gate
   * requires at least one of `phoneNumberId` / `businessAccountId`.
   */
  phoneNumberId?: string;
  appSecret: string;
  /** Stored context: enables the phone-number lookup / Kapso-native ops. */
  businessAccountId?: string;
  portfolioId?: string;
  configId?: string;
  inbound: KapsoInboundPolicy;
  allowFrom: readonly string[];
};

/** Default Kapso Meta-proxy base URL (documented host + Graph version). */
const DEFAULT_BASE_URL = "https://api.kapso.ai/meta/whatsapp/v24.0";

/** Env-var names (Infisical `channels/kapso/{env}` → runtime env). */
const ENV = {
  apiKey: "KAPSO_API_KEY",
  baseUrl: "KAPSO_BASE_URL",
  phoneNumberId: "KAPSO_PHONE_NUMBER_ID",
  appSecret: "KAPSO_APP_SECRET",
  businessAccountId: "KAPSO_BUSINESS_ACCOUNT_ID",
  portfolioId: "KAPSO_BUSINESS_PORTFOLIO_ID",
  configId: "KAPSO_CONFIG_ID",
} as const;

/**
 * Merge config + env fallback and decide whether the Kapso WhatsApp channel is
 * CREDENTIAL-COMPLETE. Returns the resolved config only when the API key, base
 * URL, sender phone-number-id, AND app secret are all present — otherwise `null`
 * (channel stays INERT). Fail-closed "no partial wiring": a half-set config never
 * half-activates. The `appSecret` is required here — an inbound webhook with no
 * `x-hub-signature-256` validation key must not run.
 */
export function resolveKapsoConfig(
  input: KapsoConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKapsoConfig | null {
  const parsed = input ?? KapsoConfigSchema.parse({});
  const apiKey = parsed.apiKey ?? env[ENV.apiKey];
  const baseUrl = parsed.baseUrl ?? env[ENV.baseUrl] ?? DEFAULT_BASE_URL;
  const phoneNumberId = parsed.phoneNumberId ?? env[ENV.phoneNumberId];
  const appSecret = parsed.appSecret ?? env[ENV.appSecret];
  const businessAccountId = parsed.businessAccountId ?? env[ENV.businessAccountId];

  // Fail-closed on the credentials required to run: API key (send auth), app
  // secret (webhook HMAC), and a send TARGET — either an explicit phone-number-id
  // OR a business-account-id it can be derived from. baseUrl always resolves.
  if (!apiKey || !appSecret || (!phoneNumberId && !businessAccountId)) {
    return null;
  }
  return {
    apiKey,
    baseUrl,
    phoneNumberId,
    appSecret,
    businessAccountId,
    portfolioId: parsed.portfolioId ?? env[ENV.portfolioId],
    configId: parsed.configId ?? env[ENV.configId],
    inbound: parsed.inbound,
    allowFrom: parsed.allowFrom,
  };
}
