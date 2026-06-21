/**
 * P3 — PHI TRIPWIRE.
 *
 * The safety invariant: memory-graphiti must NEVER send real-user PHI to Zep
 * Cloud. Zep Cloud is usable ONLY when the deployment is provably QA-only — the
 * LIVE WhatsApp allow-list contains exclusively known-synthetic/QA numbers.
 * Self-hosted Graphiti (PHI in-house) is the sanctioned path and is NEVER
 * guarded.
 *
 * Two mechanisms compose:
 *   1. A REGISTRATION GATE (in index.ts) hard-fails plugin load if the cloud
 *      backend is selected while the live allow-list is not provably QA-only.
 *   2. A RUNTIME DECORATOR (PhiTripwireGuard) wraps the cloud client so that —
 *      should the live allow-list drift to include a real user AFTER load —
 *      every PHI-bearing operation fails closed (silent drop / empty result),
 *      NEVER throwing, NEVER hitting the network.
 *
 * Everything fails closed: anything we cannot prove QA-only refuses.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { EpisodeResult, FactResult, GraphitiMessage, MemoryClient } from "./client.js";

/**
 * A recorded refusal. Emitted by the guard via onBreach so the breach is
 * observable (logged + system event) rather than silently swallowed.
 */
export type TripwireBreach = {
  op: "addMessages" | "searchFacts" | "getEpisodes";
  backendLabel: string;
  reason: "not-qa-only";
};

/**
 * Decorates a MemoryClient. While the deployment is provably QA-only it is a
 * transparent passthrough. The moment it is NOT QA-only, every PHI-bearing op
 * fails closed:
 *   - addMessages  -> silent drop (no network, returns void, NEVER throws)
 *   - searchFacts  -> returns [] (no network)
 *   - getEpisodes  -> returns [] (no network)
 *   - healthcheck  -> always delegates (carries no PHI)
 *
 * A refusal must NEVER throw — it must not break the agent reply path. Even if
 * onBreach itself throws, the guard still drops safely.
 */
export class PhiTripwireGuard implements MemoryClient {
  constructor(
    private readonly inner: MemoryClient,
    private readonly isQaOnly: () => boolean,
    private readonly onBreach: (breach: TripwireBreach) => void,
  ) {}

  get label(): string {
    return `tripwire(${this.inner.label})`;
  }

  /**
   * Fire onBreach without ever letting it throw out of the guard. The drop must
   * stay safe even if the breach reporter blows up.
   */
  private reportBreach(op: TripwireBreach["op"]): void {
    try {
      this.onBreach({ op, backendLabel: this.inner.label, reason: "not-qa-only" });
    } catch {
      // Swallow: a failing breach reporter must NOT break the fail-closed drop.
    }
  }

  async addMessages(groupId: string, messages: GraphitiMessage[]): Promise<void> {
    if (!this.isQaOnly()) {
      this.reportBreach("addMessages");
      return; // silent drop — no network, never throws
    }
    return this.inner.addMessages(groupId, messages);
  }

  async searchFacts(
    query: string,
    groupIds?: string[] | null,
    maxFacts?: number,
  ): Promise<FactResult[]> {
    if (!this.isQaOnly()) {
      this.reportBreach("searchFacts");
      return [];
    }
    return this.inner.searchFacts(query, groupIds, maxFacts);
  }

  async getEpisodes(groupId: string, lastN?: number): Promise<EpisodeResult[]> {
    if (!this.isQaOnly()) {
      this.reportBreach("getEpisodes");
      return [];
    }
    return this.inner.getEpisodes(groupId, lastN);
  }

  async healthcheck(): Promise<boolean> {
    // Healthcheck carries no PHI — always delegate.
    return this.inner.healthcheck();
  }
}

/**
 * The host authority over the LIVE WhatsApp allow-list(s).
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
 * The deployment is QA-only iff:
 *   - qaNumbers is non-empty, AND
 *   - a `channels.whatsapp` config exists, AND
 *   - EVERY enabled surface is allowlist-gated with all entries ∈ qaNumbers, AND
 *   - at least one surface actually allow-lists a QA number (so we affirmatively
 *     recognise a QA deployment, not a vacuously-empty one).
 *
 * Otherwise false (FAIL-CLOSED). Bound to the LIVE config: a real number added
 * to ANY surface's allow-list, or any surface switched off allowlist, flips this
 * to false → the guard refuses. It can never read true while a real user has
 * DM access.
 *
 * SCOPE (flagged for review): this predicate covers WhatsApp DM allow-lists per
 * the locked design. WhatsApp GROUP surfaces (groupAllowFrom/groupPolicy) and
 * OTHER channels are out of current scope — the QA deployment is WhatsApp-DM-only
 * and `slot:memory` runs behind this gate; broadening to those surfaces (or
 * other channels that could admit real users) is a conscious follow-up.
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
function normalizeAllowFrom(allowFrom: string | string[] | undefined): string[] {
  if (allowFrom === undefined) {
    return [];
  }
  return Array.isArray(allowFrom) ? allowFrom : [allowFrom];
}
