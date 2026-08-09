/**
 * Static channel-capability table (D0) — the ONLY place channels differ.
 *
 * Every channel resolves, at wire time, to a {@link ChannelCapabilities} row.
 * Keeping that table here (and nowhere else) is what lets the rest of the system
 * stay channel-agnostic: the auth/consent/delivery core reads capabilities, never
 * a channel name. {@link deliverViaCapabilities} in channel-adapter.ts consumes
 * these rows.
 *
 * FAIL-CLOSED: an unknown/mismatched/empty channel id resolves to `null` — never
 * a permissive default. A caller treats `null` as "no capabilities → deny / no
 * access". Adding a channel means adding a row here, deliberately.
 */

import type { ChannelCapabilities } from "./channel-adapter.js";

/**
 * The canonical capability rows, keyed by the exact lowercase channel id.
 *
 * `phi_approved` is `false` for ALL channels today: carrying PHI is post-BAA — a
 * later, deliberate config flip, not something a channel gets by default. Do not
 * flip it here without the BAA in place.
 *
 * `voice` DOES deliver plain text inline: the call's TTS speaks the text to the
 * caller, so `inline_text` is `true`. What a voice call cannot render is anything
 * needing rich/visual rendering — a clickable link or a readable OTP code — so
 * only link/otp fall back to the paired SMS number. This deliberately SUPERSEDES
 * the `voice` row in the approved A&D §3 D0 table (which had `inline_text: false`)
 * per CTO ruling flag1 (#5762); do not "restore" it from that table.
 *
 * `companion_text_channel` is bound PER SESSION (the paired SMS number is a
 * runtime fact, not a static one) — the static row leaves it `undefined`, but the
 * field exists so the shape is uniform across channels.
 */
const CAPABILITY_TABLE: Record<string, ChannelCapabilities> = {
  voice: {
    inline_link: false,
    inline_text: true,
    phi_approved: false,
    companion_text_channel: undefined,
  },
  sms: {
    inline_link: true,
    inline_text: true,
    phi_approved: false,
  },
  whatsapp: {
    inline_link: true,
    inline_text: true,
    phi_approved: false,
  },
};

/**
 * Resolve a channel id to its capabilities, or `null` when the channel is
 * unknown (FAIL-CLOSED — the caller denies on `null`).
 *
 * The lookup key is matched EXACTLY against the three lowercase ids; a
 * mismatched-case, whitespace-padded, or otherwise-unknown id returns `null`
 * rather than being coerced into a match (a permissive normalization would be a
 * silent access-widening). A fresh copy of the row is returned so a caller that
 * sets `companion_text_channel` per session cannot mutate the shared table.
 *
 * The lookup is guarded by {@link Object.hasOwn}: a bare `CAPABILITY_TABLE[key]`
 * would walk the prototype chain, so a key like `"__proto__"`, `"constructor"`,
 * `"toString"`, or `"hasOwnProperty"` would hit an `Object.prototype` member and
 * return a truthy non-row instead of `undefined` — silently NON-null, which
 * breaks fail-closed. The own-property guard makes every non-row key resolve to
 * `null`.
 */
export function capabilitiesFor(channelId: string): ChannelCapabilities | null {
  if (!Object.hasOwn(CAPABILITY_TABLE, channelId)) {
    return null;
  }
  return { ...CAPABILITY_TABLE[channelId] };
}

/**
 * Every channel id the D0 table declares, sorted for a stable comparison.
 *
 * Exists so a test can lock the row SET rather than only the three rows it already
 * knows about. Asserting `capabilitiesFor("voice"|"sms"|"whatsapp")` row-by-row —
 * however tightly — cannot notice a FOURTH row being added, so a new channel could
 * ship with `phi_approved: true` and fail nothing. Iterating this list instead forces
 * every present and future row through the PHI invariant (QG finding F18).
 *
 * Derived from the table itself, never hand-maintained: a hard-coded duplicate would
 * be one more thing that can silently drift out of sync with the rows it describes.
 */
export function knownChannelIds(): string[] {
  // toSorted, not sort: `sort` mutates in place, and while `Object.keys` hands back
  // a fresh array today, a non-mutating call keeps this total-over-the-table helper
  // free of any in-place step a future refactor could point at the real key source.
  return Object.keys(CAPABILITY_TABLE).toSorted();
}
