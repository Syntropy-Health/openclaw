/**
 * P3 — PHI TRIPWIRE (per-sender gate).
 *
 * The safety invariant: memory-graphiti must NEVER send real-user PHI to Zep
 * Cloud. Zep Cloud is usable ONLY for conversations whose RESOLVED SENDER is a
 * known-synthetic/QA number. Self-hosted Graphiti (PHI in-house) is the
 * sanctioned path and is NEVER guarded.
 *
 * Two mechanisms compose:
 *
 *   1. PRIMARY — a per-SENDER RUNTIME GATE at every Zep-touch site (recall,
 *      capture, and the graphiti_* tools). The Zep network is touched ONLY IF
 *      THIS conversation's resolved sender ∈ qaNumbers. This is the load-bearing
 *      control: it is robust against EVERY admission path (static-config DM
 *      allow-list, runtime pairing store, groups, other channels) because it
 *      gates at the point of PHI flow, not at a config-reading predicate.
 *
 *      The gate keys on the host-resolved `ctx.senderE164` — the canonical
 *      normalized E.164 the host computes BEFORE the session key is built. The
 *      session key is NOT a reliable sender source: under the default dmScope it
 *      collapses DMs to `main`, so it would gate against `main` instead of the
 *      real peer (fail-OPEN). senderE164 is the true sender identity.
 *
 *   2. DEFENSE-IN-DEPTH — a startup REGISTRATION GATE (computeIsQaOnly, used in
 *      index.ts) that hard-fails plugin load if the cloud backend is selected
 *      while the live WhatsApp DM allow-list is not provably QA-only. This is a
 *      fail-fast belt-and-braces check; it is NOT the load-bearing control (a
 *      config predicate is fail-OPEN against pairing/group/other-channel
 *      admission — which is exactly why the per-sender gate exists).
 *
 * Everything fails closed: anything we cannot prove QA-only refuses.
 */

import { normalizeE164, type OpenClawConfig } from "openclaw/plugin-sdk";

/**
 * A recorded refusal. Emitted via onBreach so a per-sender drop/skip is
 * observable (logged + system event) rather than silently swallowed.
 *
 * IMPORTANT: a breach NEVER carries the sender's raw value (it is PII — a phone
 * number / peer id). Only the operation + reason are recorded.
 */
export type TripwireBreach = {
  op: "addMessages" | "searchFacts" | "getEpisodes";
  backendLabel: string;
  reason: "non-qa-sender";
};

/**
 * Whether a string is a canonical E.164 phone number AS PRODUCED by
 * `normalizeE164` — `+` followed by a leading non-zero country-code digit and
 * 7–14 further digits (8–15 digits total, the E.164 maximum is 15).
 *
 * `normalizeE164` NEVER throws and NEVER signals invalidity: it strips a
 * `whatsapp:` prefix, trims, drops every non-`[\d+]` char, and re-prefixes `+`.
 * So garbage collapses to a SHORT or empty-ish form — e.g.
 *   normalizeE164("")                       === "+"
 *   normalizeE164("not-a-number")           === "+"
 *   normalizeE164("@lid")                   === "+"
 *   normalizeE164("123")                    === "+123"   (too short)
 *   normalizeE164("+15555550001")           === "+15555550001"
 *   normalizeE164("15555550001")            === "+15555550001"
 *   normalizeE164("15555550001@s.whatsapp.net") === "+15555550001"
 * — and a real E.164 lands as `+<8..15 digits>`. This predicate is therefore the
 * validity signal `normalizeE164` itself omits: we use it to (a) REJECT non-E.164
 * qaNumbers at config-parse time, and (b) implicitly fail-closed when an inbound
 * senderE164 canonicalizes to a non-E.164 shape.
 */
export function isCanonicalE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/**
 * The PRIMARY per-sender gate. Returns true — meaning "this conversation's
 * sender is sanctioned to touch Zep Cloud" — ONLY IF ALL of:
 *
 *   - `qaNumbers` is non-empty (no synthetic set ⇒ NO sender is QA ⇒ drop ALL),
 *   - `senderE164` is a non-empty string (the host resolved a sender identity),
 *     AND
 *   - the canonicalized senderE164 is a member of the canonicalized qaNumbers
 *     set.
 *
 * FAIL-CLOSED in every other case:
 *   - empty/absent qaNumbers              ⇒ false (drop ALL — even a would-be-QA
 *                                            sender),
 *   - null/undefined/empty/whitespace     ⇒ false (no resolvable sender — e.g.
 *     senderE164                            the graphiti_* tools have no ctx, and
 *                                            non-phone channels carry null),
 *   - sender ∉ qaNumbers                  ⇒ false (real user / other-channel /
 *                                            group).
 *
 * Canonicalization is `normalizeE164` on BOTH sides — defensive and idempotent.
 * senderE164 should already be canonical E.164 (the host computed it via the
 * SAME normalizeE164), and qaNumbers are stored canonical (rejected-at-parse
 * otherwise), but we normalize both identically so there is ZERO format
 * asymmetry at the membership check. A senderE164 that canonicalizes to a
 * non-E.164 shape (e.g. "+") never matches a canonical qaNumbers entry.
 */
export function senderZepAllowed(
  senderE164: string | null | undefined,
  qaNumbers: string[],
): boolean {
  if (qaNumbers.length === 0) {
    return false; // no synthetic set ⇒ no sender can be proven QA
  }
  if (typeof senderE164 !== "string" || senderE164.trim().length === 0) {
    return false; // no resolvable sender identity ⇒ fail-closed
  }
  const sender = normalizeE164(senderE164);
  const qaSet = new Set(qaNumbers.map((n) => normalizeE164(n)));
  return qaSet.has(sender);
}

/**
 * The host authority over the LIVE WhatsApp allow-list(s) — the DEFENSE-IN-DEPTH
 * startup REGISTRATION gate (used by index.ts to fail-fast plugin load).
 *
 * Returns true ONLY IF the deployment is PROVABLY QA-only across EVERY WhatsApp
 * DM access surface — the top-level `channels.whatsapp` config AND every enabled
 * per-account `channels.whatsapp.accounts[*]` (multi-account is a real config
 * path; an account carries its OWN `dmPolicy` + `allowFrom`, so checking only
 * the top level would be FAIL-OPEN — a real user authorized via an account would
 * slip past). A surface is QA-restricted iff it is allowlist-gated AND every
 * allow-list entry is a known QA number; any surface whose `dmPolicy` is not
 * `"allowlist"` (incl. the per-account default `"pairing"`, which admits any
 * pairer) is NOT QA-restricted.
 *
 * NOTE: this is NOT the load-bearing control. The real admission surface is
 * static-config DM ∪ runtime pairing-store ∪ groups ∪ other channels, which a
 * config-reading predicate cannot see — so it is fail-OPEN on its own. The
 * load-bearing control is senderZepAllowed at each Zep-touch site. This stays as
 * a fail-fast belt-and-braces check on the one surface it CAN read.
 *
 * Allow-list entries are compared canonically (normalizeE164 on both sides), so
 * a QA number written `15555550001` matches a qaNumbers entry `+15555550001`.
 *
 * The deployment is QA-only iff:
 *   - qaNumbers is non-empty, AND
 *   - a `channels.whatsapp` config exists, AND
 *   - EVERY enabled surface is allowlist-gated with all entries ∈ qaNumbers, AND
 *   - at least one surface actually allow-lists a QA number (so we affirmatively
 *     recognise a QA deployment, not a vacuously-empty one).
 *
 * Otherwise false (FAIL-CLOSED).
 */
export function computeIsQaOnly(config: OpenClawConfig, qaNumbers: string[]): boolean {
  if (qaNumbers.length === 0) {
    return false; // no synthetic set defined — cannot prove QA-only
  }
  const wa = config.channels?.whatsapp;
  if (!wa) {
    return false; // no whatsapp channel — cannot prove QA-only
  }
  const qaSet = new Set(qaNumbers.map((n) => normalizeE164(n)));

  // Every DM access surface that can admit a sender: top-level + enabled accounts.
  const surfaces: Array<{ dmPolicy?: string; allowFrom?: string | string[] }> = [
    { dmPolicy: wa.dmPolicy, allowFrom: wa.allowFrom },
  ];
  for (const account of Object.values(wa.accounts ?? {})) {
    if (!account || account.enabled === false) {
      continue; // a disabled account starts no provider — admits no one
    }
    surfaces.push({ dmPolicy: account.dmPolicy, allowFrom: account.allowFrom });
  }

  for (const surface of surfaces) {
    if (surface.dmPolicy !== "allowlist") {
      return false; // a non-allowlist surface can admit non-allowlisted (real) users
    }
    const allow = normalizeAllowFrom(surface.allowFrom);
    // An allowlist surface with an EMPTY allow-list admits EVERYONE at runtime
    // (src/plugin-sdk/allow-from.ts:28 — length 0 ⇒ allowed), and a "*" entry is
    // the universal-admit wildcard (allow-from.ts:31). Both are fail-OPEN, so a
    // QA-only deployment must have a NON-EMPTY, wildcard-free allow-list on every
    // surface.
    if (allow.length === 0 || allow.includes("*")) {
      return false;
    }
    if (!allow.every((entry) => qaSet.has(normalizeE164(entry)))) {
      return false; // a non-QA number is allow-listed on this surface
    }
  }

  // Every enabled surface is allowlist-gated to a non-empty subset of qaNumbers.
  return true;
}

/** Normalize allowFrom (string | string[] | undefined) to string[]. */
export function normalizeAllowFrom(allowFrom: string | string[] | undefined): string[] {
  if (allowFrom === undefined) {
    return [];
  }
  return Array.isArray(allowFrom) ? allowFrom : [allowFrom];
}
