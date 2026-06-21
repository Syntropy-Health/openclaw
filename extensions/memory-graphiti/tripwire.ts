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
 *   2. DEFENSE-IN-DEPTH — a startup REGISTRATION GATE (computeIsQaOnly, used in
 *      index.ts) that hard-fails plugin load if the cloud backend is selected
 *      while the live WhatsApp DM allow-list is not provably QA-only. This is a
 *      fail-fast belt-and-braces check; it is NOT the load-bearing control (a
 *      config predicate is fail-OPEN against pairing/group/other-channel
 *      admission — which is exactly why the per-sender gate exists).
 *
 * Everything fails closed: anything we cannot prove QA-only refuses.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { extractSenderFromSessionKey } from "./config.js";

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
 * Extract the conversation's resolved SENDER (peer id) from a session key.
 *
 * Session key format: `agent:<agentId>:<channel>:<type>:<peerId>` — the sender
 * is the last non-empty `:`-segment. Mirrors config.ts's group_id derivation so
 * the gate keys off the SAME notion of "who is this conversation with".
 *
 * Returns null if the sender is unresolvable (no/empty session key, or a shape
 * that does not yield a peer id) — callers treat null as fail-closed.
 */
export function extractSender(sessionKey: string | undefined): string | null {
  if (!sessionKey) {
    return null;
  }
  return extractSenderFromSessionKey(sessionKey);
}

/**
 * The PRIMARY per-sender gate. Returns true — meaning "this conversation's
 * sender is sanctioned to touch Zep Cloud" — ONLY IF ALL of:
 *
 *   - `qaNumbers` is non-empty (no synthetic set ⇒ NO sender is QA ⇒ drop ALL),
 *   - the sender resolves to a non-null value, AND
 *   - the resolved sender is a member of the qaNumbers set.
 *
 * FAIL-CLOSED in every other case:
 *   - empty/absent qaNumbers      ⇒ false (drop ALL — even a would-be-QA sender),
 *   - unresolvable/empty sender   ⇒ false,
 *   - sender ∉ qaNumbers          ⇒ false (real user / other-channel / group).
 *
 * `"*"` is NOT a wildcard here. qaNumbers entries are compared by exact (trim-
 * normalized) equality against the resolved sender. A real sender is never the
 * literal "*", so a "*" entry simply never matches; and we additionally refuse
 * to let a "*" sender match a "*" qaNumbers entry (defensive — senders aren't
 * "*", so this can only arise from a malformed session key, which must drop).
 *
 * Normalization is trim-only, matching how qaNumbers are parsed in config.ts.
 */
export function senderZepAllowed(sessionKey: string | undefined, qaNumbers: string[]): boolean {
  if (qaNumbers.length === 0) {
    return false; // no synthetic set ⇒ no sender can be proven QA
  }
  const sender = extractSender(sessionKey);
  if (sender === null) {
    return false; // unresolvable sender ⇒ fail-closed
  }
  const normalized = sender.trim();
  if (normalized.length === 0 || normalized === "*") {
    // Empty or wildcard-shaped sender: never sanctioned. "*" is not a real peer
    // id; refuse it even if "*" somehow appears in qaNumbers.
    return false;
  }
  const qaSet = new Set(qaNumbers.map((n) => n.trim()));
  return qaSet.has(normalized);
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
  const qaSet = new Set(qaNumbers);

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
    if (!allow.every((entry) => qaSet.has(entry))) {
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
