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
 * (The former `voice` row's flag1 semantics — TTS speaks inline text, only
 * link/OTP fell back to the paired SMS number — live in the removal comment
 * below and in the flag1 reference block of the test suite. #216.)
 *
 * `companion_text_channel` is bound PER SESSION (the paired SMS number is a
 * runtime fact, not a static one) — the static row leaves it `undefined`, but the
 * field exists so the shape is uniform across channels.
 */
const CAPABILITY_TABLE: Record<string, ChannelCapabilities> = {
  // `sms`: RESTORED under SYN-272 R2 [PRINCIPAL-RULED 2026-08-27,
  // cto-loop — recorded in CTO dispatch #7596 + SYN-272 Provenance:
  // "productionize WhatsApp + SMS… This SUPERSEDES the earlier SMS
  // de-funding ruling"]. History, kept because the provenance discipline
  // cuts both ways: #216 REMOVED this row under the 2026-08-21 de-funding
  // ruling ("staging-only EXPERIMENT. SMS is OUT OF SCOPE"), noting
  // reinstatement "needs the ruling revisited AND the E.164/pairing design
  // funded — a product decision, not a config flip." Both conditions were
  // met by the 2026-08-27 supersession + the channel-surfaces PVR (R3
  // funds A7 pairing; R5 the consent record). Row shape per PVR R2:
  // phi_approved:false is PERMANENT for sms — the body carries no PHI
  // ever (notification + tracked /r/ link into the authed app; PVR R6 SMS
  // arm) — so unlike whatsapp there is NO post-BAA flip on this row.
  sms: {
    inline_link: true,
    inline_text: true,
    phi_approved: false,
  },
  //
  // `voice`: REMOVED [CTO-JUDGEMENT, dispatch #6654 — NOT principal-ruled;
  // the "and voice" in the relay was an inference inside a PRINCIPAL RULED
  // paragraph, recorded as such]. Auditable basis: (a) same evidence as sms
  // (no production app, no channel creds on staging, Phase 7 adapters at
  // zero non-test call sites); (b) SJ's manifests already shipped without
  // voice (SJ #1761), and a capability table asserting a channel the
  // declared contract refuses to advertise is two truths in disagreement;
  // (c) voice is UNPAIRABLE today — absent from SJ's A7_CHANNELS pairing
  // allowlist (SJ functions/db_utils/channel_consent.py) — so advertising it
  // was false regardless of scope. UNLIKE sms this is REVERSIBLE same-day:
  // if voice gains a pairing path, restore the row AS IT WAS —
  // { inline_link: false, inline_text: true, phi_approved: false,
  //   companion_text_channel: undefined } — inline_text:true per CTO ruling
  // flag1 (#5762), which deliberately SUPERSEDED the approved A&D §3 row
  // (inline_text:false): TTS speaks inline text; only link/OTP fell back to
  // the paired SMS number. Do NOT restore from the A&D's superseded table.
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
 * The lookup key is matched EXACTLY against the declared lowercase ids; a
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
 * Exists so a test can lock the row SET rather than only the rows it already
 * knows about. Asserting `capabilitiesFor("voice"|"sms"|"whatsapp")` row-by-row —
 * however tightly — cannot notice an EXTRA row being added, so a new channel could
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
