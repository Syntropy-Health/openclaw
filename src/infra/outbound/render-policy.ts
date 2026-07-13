/**
 * ChannelRenderingPolicy (R7 channel degradation) — PHI-aware component→text
 * degradation for outbound messaging channels.
 *
 * WhatsApp/Slack/Telegram/etc. are messaging channels with no native component
 * render surface, so a ComponentDescriptor that rides in a reply payload's
 * `channelData` MUST degrade to plain text before it leaves the gateway.
 *
 * PHI boundary (ratified A&D R7 + Q6) — the minimization gate is CHANNEL-KEYED
 * and fully fail-closed, NOT per-field and NOT per-descriptor-field:
 *   - phiApproved (non-denylisted) channel → full `ui.summary` (health permitted).
 *   - EVERY other case                     → MINIMIZE (generic confirm + optional
 *     deep-link, NEVER `ui.summary`).
 * There is NO descriptor escape hatch. `render` is producer-controlled, so a
 * nav/url pass-through would be a smuggling vector — a mismarked/compromised
 * backend could tag a food-log card render:"navigate" to leak the summary. The
 * ONLY full-summary path is an explicitly-phiApproved channel. Nav rendering (and
 * its own non-PHI safety analysis for nav summaries) is deferred to the
 * openclaw-channel-tool-hooks workstream, which owns that surface.
 * Rationale: `ui.summary` is contractually health-bearing (the canonical example
 * is "Log salmon meal — 340 cal, 34g protein") and field-level `sensitivity` is
 * OPTIONAL — a producer that omits it must NOT downgrade the boundary. So we
 * presume health on every non-approved channel.
 *
 * This is the messaging-channel counterpart to the HTTP presentation path
 * (shrinemobile/webchat), where a component egresses as a first-class output
 * item. deliver.ts only ever sees messaging channels, so v1 always degrades to
 * text here; the `passthrough` plan kind is reserved/typed for a future rich
 * channel that can render a component natively.
 */

import type { ComponentDescriptor } from "../../gateway/component-descriptor.schema.js";
import { parseComponentDescriptor } from "../../gateway/component-descriptor.schema.js";

export type RenderPlan =
  /** Leave channelData intact — a rich channel can render the component. Reserved: no messaging channel uses this in v1. */
  | { kind: "passthrough" }
  /** Degrade to this text and DROP channelData. `minimized` marks PHI-stripped output (media is also dropped). */
  | { kind: "text"; text: string; minimized: boolean };

export type ChannelRenderingOptions = {
  /** Channels allowed to receive health-specific content (Q6 default: [] — nothing approved). */
  phiApprovedChannels?: readonly string[];
  /** Optional deep-link base (e.g. "https://app.shrine.../confirm/") appended with pending_id when minimizing. */
  deepLinkBase?: string;
};

/**
 * Generic confirm text used when a descriptor egresses to a NON-phiApproved
 * channel. Carries NO health specifics — never derived from `ui.summary`, which
 * may contain health details (e.g. a meal's calories/macros).
 */
export const MINIMIZED_HEALTH_CONFIRM_TEXT =
  "You have a pending action to confirm. Open the app to review and confirm.";

/**
 * First-party surfaces where PHI egress via `phiApprovedChannels` config is
 * permitted — the app's own channels the operator fully controls.
 *
 * SEC-IRC (deny-unknown posture, CTO #3578): this ALLOWLIST is the enforcement
 * mechanism, NOT the denylist below. `isThirdPartyChannel` returns true for any
 * channel NOT in this set — so a known third-party provider, an unknown/future
 * channel, or a channel omitted from the denylist (the `irc` fail-open) are ALL
 * refused at RUNTIME, not merely caught by a lint. Adding a new channel is
 * safe-by-default (PHI-denied) until it is deliberately allowlisted here.
 */
const FIRST_PARTY_PHI_CHANNELS: ReadonlySet<string> = new Set([
  "shrinemobile",
  "webchat",
  // NOTE (CTO #3581): `matrix` is NOT first-party — a federated messaging
  // provider is squarely the SEC-4 counsel-gate class. A federation-disabled
  // self-hosted homeserver may re-argue first-party later WITH deployment
  // evidence; until then it is third-party (PHI-denied) like any messaging channel.
]);

/**
 * SEC-4 counsel-gate: DOCUMENTATION of the known third-party messaging providers.
 * This list is NOT the enforcement mechanism — enforcement is the deny-unknown
 * `FIRST_PARTY_PHI_CHANNELS` allowlist above (`isThirdPartyChannel` denies any
 * channel not in it, so these — and any unlisted/future channel — are IGNORED in
 * `phiApprovedChannels` and still minimized, regardless of operator typo/error).
 * The registry-completeness test asserts `isThirdPartyChannel(c) === true` for
 * every `CHAT_CHANNEL_ORDER` channel (the real, stronger invariant), so a core
 * channel can never be first-party by omission. A real approval requires a
 * separate counsel-gated path.
 */
export const KNOWN_THIRD_PARTY_CHANNELS: readonly string[] = [
  "whatsapp",
  "slack",
  "telegram",
  "discord",
  "imessage",
  "signal",
  "googlechat",
  "irc",
];

/** Normalize a channel name for comparison — case- and whitespace-insensitive. */
function normalizeChannelName(channel: string): string {
  return channel.trim().toLowerCase();
}

/**
 * True unless the channel is an explicit first-party surface (deny-unknown).
 * A third-party channel can never be phiApproved via plain config.
 */
export function isThirdPartyChannel(channel: string): boolean {
  return !FIRST_PARTY_PHI_CHANNELS.has(normalizeChannelName(channel));
}

/**
 * Strip denylisted third-party channels from a configured phiApproved list.
 * Returns the honored `approved` list and the `ignored` (denylisted) entries so
 * the caller can emit a one-time warning. Comparison is normalized (case +
 * whitespace) so `'WhatsApp'` / `' whatsapp '` are still recognized and stripped.
 */
export function sanitizePhiApprovedChannels(configured: readonly string[] | undefined): {
  approved: string[];
  ignored: string[];
} {
  const approved: string[] = [];
  const ignored: string[] = [];
  for (const channel of configured ?? []) {
    if (isThirdPartyChannel(channel)) {
      ignored.push(channel);
    } else {
      approved.push(channel);
    }
  }
  return { approved, ignored };
}

/** PHI signal helper: true iff any editable field is marked `sensitivity: "health"`. */
export function descriptorHasHealthContent(descriptor: ComponentDescriptor): boolean {
  // props is opaque and unmarked — the sensitivity contract is field-level only.
  return descriptor.ui.fields?.some((field) => field.sensitivity === "health") ?? false;
}

/**
 * Decide how `descriptor` renders on the outbound messaging `channel`.
 * v1: always "text" (messaging channels can't render components).
 *
 * Fully fail-closed: the ONLY full-summary path is an explicitly-phiApproved,
 * non-denylisted channel. There is NO descriptor-field escape hatch — `render`
 * is producer-controlled, so a nav/url pass-through would let a mismarked or
 * compromised backend smuggle a health summary (e.g. tagging a food-log card
 * render:"navigate"). Nav rendering + its own non-PHI safety analysis for nav
 * summaries are deferred to the openclaw-channel-tool-hooks workstream, which
 * owns that surface.
 */
export function planChannelRender(
  descriptor: ComponentDescriptor,
  channel: string,
  opts?: ChannelRenderingOptions,
): RenderPlan {
  const { approved } = sanitizePhiApprovedChannels(opts?.phiApprovedChannels);

  if (approved.includes(channel)) {
    // phiApproved (and NOT a denylisted third-party): full summary permitted.
    return { kind: "text", text: descriptor.ui.summary, minimized: false };
  }

  // Everything else — ANY descriptor on a non-phiApproved channel, including
  // render:navigate|url — is minimized. Presume health-bearing.
  return { kind: "text", text: minimizedText(descriptor, opts), minimized: true };
}

/** Generic confirm + optional deep-link (deepLinkBase + pending_id). Never includes ui.summary. */
function minimizedText(descriptor: ComponentDescriptor, opts?: ChannelRenderingOptions): string {
  const base = opts?.deepLinkBase;
  const pendingId = descriptor.ui.pending_id;
  if (base && pendingId) {
    return `${MINIMIZED_HEALTH_CONFIRM_TEXT} ${base}${pendingId}`;
  }
  return MINIMIZED_HEALTH_CONFIRM_TEXT;
}

/**
 * Fail-safe decision for a raw payload `channelData` envelope.
 * - Not a component carrier (`type !== "component"`) → "none" (leave untouched).
 * - A component carrier that FAILS to parse (malformed key / missing summary /
 *   pending_id-without-expiry / proto-pollution / over-depth) is UNTRUSTED →
 *   SCRUB to the minimized confirm text and drop it (SEC-2: never forward an
 *   unparseable component's text or raw envelope).
 * - A parseable component carrier → the channel-keyed render plan.
 */
export type CarrierRenderDecision =
  | { action: "none" }
  | { action: "scrub"; text: string; minimized: boolean };

export function planChannelDataRender(
  channelData: Record<string, unknown> | undefined,
  channel: string,
  opts?: ChannelRenderingOptions,
): CarrierRenderDecision {
  if (!channelData || channelData.type !== "component") {
    return { action: "none" };
  }
  const descriptor = parseComponentDescriptor(channelData.component);
  if (!descriptor) {
    // SEC-2 fail-safe: an unparseable component is untrusted — minimize + drop.
    return { action: "scrub", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true };
  }
  const plan = planChannelRender(descriptor, channel, opts);
  if (plan.kind === "passthrough") {
    return { action: "none" };
  }
  return { action: "scrub", text: plan.text, minimized: plan.minimized };
}
