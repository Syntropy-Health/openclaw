/**
 * The E.164 gate shared by all three Phase 7 channel adapters (QG F1 / F3).
 *
 * ## Why this exists
 *
 * `normalizeE164` (`openclaw/plugin-sdk`) is a NORMALIZER, not a VALIDATOR. It is
 * total: it strips every character outside `[\d+]` and re-prefixes `+`, so it can
 * never say "that was not a phone number". Measured behaviour:
 *
 * ```
 *   normalizeE164("sip:alice@1650.555.1234.evil.com") === "+16505551234"
 *   normalizeE164("client:bob99")                     === "+99"
 *   normalizeE164("12+34")                            === "+12+34"
 *   normalizeE164("0016505551234")                    === "+0016505551234"
 *   normalizeE164("not-a-number")                     === "+"
 * ```
 *
 * The first line is the whole reason this module is not optional. `identity()` is
 * an AUTHENTICATION surface — it decides WHO the caller is — and a Twilio `From`
 * is not always E.164: Twilio Client sends `client:<identity>` and a Programmable
 * SIP Domain sends a CALLER-SUPPLIED SIP URI. Digit-scraping a SIP URI therefore
 * lets an attacker choose which E.164 they resolve to, and land on the victim's.
 * Guarding only against the degenerate `"+"` (what the adapters shipped with)
 * catches the last line and none of the others.
 *
 * ## The two-part gate
 *
 * 1. **Shape-gate the RAW input** — a sender must LOOK like a phone number before
 *    we are willing to normalize it. This is what refuses `sip:…` and `client:…`
 *    OUTRIGHT rather than scraping digits out of them, and it is the half that
 *    actually closes the collision. It also rejects an interior `+` (`12+34`),
 *    which the old `=== "+"` guard passed straight through.
 * 2. **Validate the NORMALIZED result** against canonical E.164. This SUBSUMES the
 *    old degenerate-`"+"` check (`"+"` fails it), so the adapters carry one gate,
 *    not two.
 *
 * ## Prior art / duplication
 *
 * The canonical regex is deliberately IDENTICAL to `isCanonicalE164` in
 * `extensions/memory-graphiti/tripwire.ts` (same `/^\+[1-9]\d{7,14}$/`, same
 * rationale: `+`, a non-zero country-code digit, 7–14 more digits, 15 total max).
 * It is re-declared rather than imported because `memory-graphiti` is an
 * INDEPENDENT plugin package (`@openclaw/memory-graphiti`, with its own
 * `@getzep/zep-cloud` dependency tree) that a deployment may not install at all —
 * making a channel adapter's auth path depend on the PHI-memory plugin would be a
 * dependency inversion far worse than one duplicated literal. Keep the two in
 * sync; they encode the same standard.
 *
 * ## Known limitation (deliberate, documented)
 *
 * This is a SYNTAX gate, not a numbering-plan gate. `"(650) 555-1234"` — a US
 * national-format number — shape-passes and normalizes to `"+6505551234"`, which
 * is syntactically canonical E.164 even though `+650` is not the intended country
 * code. Closing that requires a country-code allowlist or libphonenumber, and it
 * cannot be closed by requiring a leading `+`: Meta/Kapso delivers `from` as BARE
 * DIGITS, and a session legitimately bound from that native shape must normalize
 * rather than be refused. Tracked as a residual, not fixed here.
 */

import { normalizeE164 } from "openclaw/plugin-sdk";

/**
 * What a RAW sender/destination is allowed to look like BEFORE normalization:
 * an optional leading `+`, then digits and conventional phone punctuation
 * (spaces, parentheses, dots, hyphens) only.
 *
 * The `+` is anchored to the front on purpose — `12+34` must not pass. Letters,
 * `@`, and `:` are absent on purpose — that is precisely what refuses a SIP URI
 * or a `client:` identity instead of harvesting the digits inside it.
 */
const PHONE_SHAPED = /^\+?[\d\s().-]+$/;

/**
 * Canonical E.164 as `normalizeE164` would produce it for a real number: `+`, a
 * non-zero country-code digit, then 7–14 further digits (8–15 total; 15 is the
 * E.164 maximum). Mirrors `isCanonicalE164` in memory-graphiti/tripwire.ts.
 */
const CANONICAL_E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalize `raw` to canonical E.164, or THROW.
 *
 * One validator for BOTH directions, deliberately:
 *  - INBOUND (`identity()`): a sender we cannot canonicalize is a sender we cannot
 *    identify, and `ChannelIdentity` is non-nullable — throwing is the only
 *    alternative to fabricating an identity for an authenticated session.
 *  - OUTBOUND (construction-time destination binding): the TCPA opt-out store
 *    matches `channel_peer_id` EXACTLY, so a destination of `"16505551234"` or
 *    `"(650) 555-1234"` MISSES a STOP row stored as `"+16505551234"` and sends to
 *    a number that opted out. Normalizing the destination is what makes the
 *    opt-out lookup and the stored key the same string.
 *
 * @param raw the provider-supplied value, un-normalized.
 * @param subject a value-free description of what failed, e.g.
 *   `"sms adapter: inbound 'From'"`. It is interpolated into the thrown message,
 *   so it MUST NOT contain `raw`: a phone number is an identifier and must never
 *   reach a log via an exception message.
 * @throws if `raw` is not phone-shaped, or does not normalize to canonical E.164.
 */
export function toCanonicalE164(raw: string, subject: string): string {
  if (!PHONE_SHAPED.test(raw.trim())) {
    throw new Error(`${subject} is not phone-shaped and was not normalized`);
  }

  const e164 = normalizeE164(raw);
  if (!CANONICAL_E164.test(e164)) {
    throw new Error(`${subject} does not normalize to a canonical E.164 number`);
  }

  return e164;
}
