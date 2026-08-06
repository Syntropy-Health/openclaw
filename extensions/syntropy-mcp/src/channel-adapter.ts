/**
 * ChannelAdapter — the per-channel delivery seam (C0) for multichannel
 * authenticated access.
 *
 * The core auth/consent flow must NEVER branch on which channel a user is on.
 * A channel differs only in (a) how it names an inbound sender, and (b) what it
 * can physically deliver — a rich channel (SMS/WhatsApp) can put a link or an
 * OTP inline; a voice call cannot render a URL, so link/otp must fall back to a
 * PAIRED companion SMS number. That difference is captured DECLARATIVELY in
 * {@link ChannelCapabilities} and resolved ONCE by {@link deliverViaCapabilities}
 * — the atomicity seam. Every concrete adapter's `deliver()` delegates to it, so
 * no caller anywhere else has to know "is this voice?".
 *
 * This module owns the CONTRACT (types + the shared resolver). The concrete,
 * per-provider adapters — the code that normalizes an inbound webhook into an
 * {@link ChannelIdentity} and wires the real inline/companion sinks — live in the
 * thin channel adapters (Phase 7), not here.
 */

// ---------------------------------------------------------------------------
// Public types — the FROZEN seam SJ builds against. Do not rename/restructure.
// ---------------------------------------------------------------------------

/**
 * What a channel can physically do with a delivery. The ONLY place channels
 * differ (D0 — see channel-capability-config.ts for the static table).
 *
 *  - `inline_link` — can the channel render a clickable link / an OTP code
 *    inline (link and otp both require rich inline rendering)?
 *  - `inline_text` — can the channel deliver a plain text message inline?
 *  - `phi_approved` — is this channel cleared to carry PHI? (Post-BAA; `false`
 *    everywhere today — see the D0 table.)
 *  - `companion_text_channel` — the paired SMS number (E.164) to fall back to
 *    when the channel cannot deliver inline (e.g. a voice call's linked SMS).
 *    Set per-session at wire time; absent when the channel has no companion.
 */
export type ChannelCapabilities = {
  inline_link: boolean;
  inline_text: boolean;
  phi_approved: boolean;
  companion_text_channel?: string /* E.164 */;
};

/**
 * A thing to deliver. `text` is a plain message; `link` a URL; `otp` a one-time
 * code. `link` and `otp` require rich inline rendering (gated by `inline_link`);
 * `text` is gated by `inline_text`.
 */
export type DeliveryPayload =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }
  | { kind: "otp"; code: string };

/** The outcome of a delivery: did it succeed, and by which route. */
export type DeliveryResult = { ok: boolean; via: "inline" | "companion" };

/** The normalized identity of an inbound sender: an E.164 number + channel id. */
export type ChannelIdentity = { e164: string; channelId: string };

/**
 * A concrete channel binding. `identity` normalizes a raw inbound message into
 * a {@link ChannelIdentity}; `capabilities` declares what the channel can do;
 * `deliver` sends a payload (delegating to {@link deliverViaCapabilities} so the
 * inline/companion decision is made in exactly one place).
 */
export interface ChannelAdapter {
  identity(inbound: unknown): { e164: string; channelId: string };
  capabilities: ChannelCapabilities;
  deliver(payload: DeliveryPayload): Promise<DeliveryResult>;
}

// ---------------------------------------------------------------------------
// The shared capability-fallback resolver — the atomicity seam.
// ---------------------------------------------------------------------------

/**
 * Resolve a delivery against a channel's capabilities, choosing EXACTLY ONE of
 * two sinks (or neither, fail-closed). This is the atomicity seam: an adapter's
 * `deliver()` delegates here so the "can this channel render this inline?"
 * decision is made in one place and the core never branches on channel.
 *
 * Resolution (voice: inline_link=false → a link/otp goes to the companion SMS):
 *  1. Pick the relevant inline capability for the payload — `link`/`otp` need
 *     rich inline rendering (`inline_link`); `text` needs `inline_text`.
 *  2. Capability TRUE  → send inline via `sinks.inline`; `{ ok, via: "inline" }`.
 *  3. Capability FALSE →
 *       - a non-empty `companion_text_channel` is set → send via
 *         `sinks.companion(companion, payload)`; `{ ok, via: "companion" }`.
 *       - otherwise → FAIL-CLOSED: return `{ ok: false, via: "companion" }`
 *         WITHOUT calling either sink and WITHOUT throwing. A channel that can
 *         neither deliver inline nor fall back must not silently drop or crash —
 *         it reports `ok: false` so the caller can react.
 *
 * Exactly one sink is ever invoked (or neither, in the fail-closed case) — never
 * both.
 */
export async function deliverViaCapabilities(
  caps: ChannelCapabilities,
  payload: DeliveryPayload,
  sinks: {
    inline: (p: DeliveryPayload) => Promise<boolean>;
    companion: (toE164: string, p: DeliveryPayload) => Promise<boolean>;
  },
): Promise<DeliveryResult> {
  // link/otp require rich inline rendering; text needs plain inline text.
  const inlineCapable = payload.kind === "text" ? caps.inline_text : caps.inline_link;

  if (inlineCapable) {
    const ok = await sinks.inline(payload);
    return { ok, via: "inline" };
  }

  const companion = caps.companion_text_channel;
  if (companion !== undefined && companion.length > 0) {
    const ok = await sinks.companion(companion, payload);
    return { ok, via: "companion" };
  }

  // Fail-closed: cannot deliver inline and no companion to fall back to. Do not
  // call either sink; do not throw — report the failure.
  return { ok: false, via: "companion" };
}
