/**
 * ChannelRenderingPolicy (R7 channel degradation) — PHI-aware component→text
 * degradation for outbound messaging channels.
 *
 * WhatsApp/Slack/Telegram/etc. are messaging channels with no native component
 * render surface, so a ComponentDescriptor that rides in a reply payload's
 * `channelData` MUST degrade to plain text before it leaves the gateway. The
 * text is chosen PHI-aware: per the ratified Q6 ruling, a channel is trusted
 * with health-specific content ONLY when it is explicitly phiApproved (default:
 * none — WhatsApp is NOT phiApproved). On a non-approved channel, a descriptor
 * carrying health-marked fields is MINIMIZED to a generic confirm string (plus
 * an optional deep-link) so NO health specifics egress to the channel provider.
 *
 * This is the messaging-channel counterpart to the HTTP presentation path
 * (shrinemobile/webchat), where a component egresses as a first-class output
 * item. deliver.ts only ever sees messaging channels, so v1 always degrades to
 * text here; the `passthrough` plan kind is reserved/typed for a future rich
 * channel that can render a component natively.
 */

import type { ComponentDescriptor } from "../../gateway/component-descriptor.schema.js";

export type RenderPlan =
  /** Leave channelData intact — a rich channel can render the component. Reserved: no messaging channel uses this in v1. */
  | { kind: "passthrough" }
  /** Degrade to this text and DROP channelData (falls through to the text-send path). */
  | { kind: "text"; text: string };

export type ChannelRenderingOptions = {
  /** Channels allowed to receive health-specific content (Q6 default: [] — nothing approved). */
  phiApprovedChannels?: readonly string[];
  /** Optional deep-link base (e.g. "https://app.shrine.../confirm/") appended with pending_id when minimizing. */
  deepLinkBase?: string;
};

/**
 * Generic confirm text used when a health-marked descriptor egresses to a
 * NON-phiApproved channel. Carries NO health specifics — never derived from
 * `ui.summary`, which may contain health details (e.g. a meal's calories).
 */
export const MINIMIZED_HEALTH_CONFIRM_TEXT =
  "You have a pending action to confirm. Open the app to review and confirm.";

/** PHI detection: true iff any editable field is marked `sensitivity: "health"`. */
export function descriptorHasHealthContent(descriptor: ComponentDescriptor): boolean {
  // props is opaque and unmarked — the sensitivity contract is field-level only.
  return descriptor.ui.fields?.some((field) => field.sensitivity === "health") ?? false;
}

/**
 * Decide how `descriptor` renders on the outbound messaging `channel`.
 *
 * v1: always "text" (messaging channels can't render components). The text is:
 * - phiApproved channel                    → full `ui.summary` (health specifics permitted).
 * - non-phiApproved + health content       → MINIMIZED generic text (+ optional deep-link); NEVER `ui.summary`.
 * - non-phiApproved + no health content    → `ui.summary` (no health content → safe).
 */
export function planChannelRender(
  descriptor: ComponentDescriptor,
  channel: string,
  opts?: ChannelRenderingOptions,
): RenderPlan {
  const phiApproved = opts?.phiApprovedChannels ?? [];
  const channelIsPhiApproved = phiApproved.includes(channel);

  if (!channelIsPhiApproved && descriptorHasHealthContent(descriptor)) {
    return { kind: "text", text: minimizedText(descriptor, opts) };
  }

  // phiApproved channel, OR no health content: ui.summary is safe to send.
  return { kind: "text", text: descriptor.ui.summary };
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
