/**
 * WhatsApp dual-path transport policy (B-Twilio-2, slice 2).
 *
 * The `whatsapp` channel can run on either the legacy Baileys transport (default)
 * or the Twilio WABA transport. This module holds the schema-level **dormant
 * prod-reject**: once the migration cuts over (slice 3), the Baileys path must
 * not run in prod. It ships DORMANT — `cutoverComplete` defaults false, so the
 * reject is inert until the cutover flips it. Until then Baileys stays the
 * default+only live transport with zero behavior change.
 */

export type WhatsAppTransport = "baileys" | "twilio-waba";

export type TransportPolicyInput = {
  transport: WhatsAppTransport;
  /** Deployment environment (e.g. "prod" | "test" | "dev"). */
  env: string;
  /** True only post-cutover (slice 3). Keeps the prod-reject DORMANT until then. */
  cutoverComplete: boolean;
};

/**
 * Enforce the transport policy. Post-cutover, the Baileys WhatsApp transport is
 * rejected in prod (WABA is the sanctioned path). Throws on violation; a no-op
 * in every other case (including the entire pre-cutover period).
 */
export function assertTransportAllowed(input: TransportPolicyInput): void {
  if (input.cutoverComplete && input.env === "prod" && input.transport === "baileys") {
    throw new Error(
      "WhatsApp transport 'baileys' is rejected in prod post-cutover; use 'twilio-waba'.",
    );
  }
}

/**
 * Whether the WABA cutover has completed. Defaults false (dormant) — flipped to
 * `true` (via `WABA_CUTOVER_COMPLETE=true`) only at cutover, under CTO go.
 */
export function isCutoverComplete(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WABA_CUTOVER_COMPLETE === "true";
}
