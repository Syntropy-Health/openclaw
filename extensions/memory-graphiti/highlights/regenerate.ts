import { MemoryCapabilityError, type MemoryFact, type MemoryFactSurface } from "../client.js";
import type { GenerateResult } from "./generate.js";
import type { HighlightStore } from "./store.js";

/**
 * listFacts calls per regeneration. One call reads up to the backend's own ceiling
 * (2,000 on Zep), the per-user bound A&D §4.1/§7 set; the newest 300 go to the model.
 */
export const LIST_PAGES_MAX = 1;
/** The regeneration lease: longer than a listing plus the 30 s summariser budget. */
export const REGEN_LEASE_SEC = 120;

export type RegenerateOutcome =
  | "ready"
  | "empty"
  | "unavailable"
  | "kept_previous"
  | "gone"
  /** Another instance holds the group's lease: it is regenerating right now. */
  | "busy"
  /** A remove or forget changed the row during the run: nothing written, still stale. */
  | "superseded"
  | "backend_unsupported"
  | "error";

export type RegenerateDeps = {
  client: Pick<MemoryFactSurface, "listFacts">;
  store: Pick<HighlightStore, "clock" | "get" | "put" | "acquireLease" | "releaseLease">;
  /** generateHighlights bound to this group, runner and rank config. */
  generate: (facts: MemoryFact[]) => Promise<GenerateResult>;
  logger: { info: (m: string) => void; warn: (m: string) => void };
};

/**
 * Regenerate one group's highlights (A&D §4.4). The caller holds the in-process
 * group lock; across instances, the database lease makes one run per group at a
 * time, and the result is written only at the epoch read when the run began, so a
 * remove or a forget on any instance always wins. Only a group that has a row is
 * generated. A failed run never replaces highlights the user already had. Logs
 * carry outcomes and counts only, never the group or error text.
 */
export async function regenerateGroup(
  groupId: string,
  deps: RegenerateDeps,
): Promise<RegenerateOutcome> {
  const before = await deps.store.get(groupId);
  if (!before) {
    return "gone";
  }
  if (!(await deps.store.acquireLease(groupId, REGEN_LEASE_SEC))) {
    return "busy";
  }
  try {
    return await regenerateLeased(groupId, before, deps);
  } finally {
    await deps.store.releaseLease(groupId).catch(() => undefined);
  }
}

async function regenerateLeased(
  groupId: string,
  before: NonNullable<Awaited<ReturnType<RegenerateDeps["store"]["get"]>>>,
  deps: RegenerateDeps,
): Promise<RegenerateOutcome> {
  const startedAt = await deps.store.clock();

  const facts: MemoryFact[] = [];
  // Partial = the listing stopped at the backend ceiling with facts left: the model
  // never saw them. Stored with the result, so it is never served as complete.
  let partial = false;
  try {
    let cursor: string | undefined;
    let exhausted = false;
    for (let page = 0; page < LIST_PAGES_MAX; page++) {
      const res = await deps.client.listFacts(groupId, { includeInvalid: false, cursor });
      facts.push(...res.facts);
      partial = res.truncated === true;
      if (!res.nextCursor) {
        exhausted = true;
        break;
      }
      cursor = res.nextCursor;
    }
    // Our own page cap stopped the read with facts left: partial, whatever the backend said.
    partial ||= !exhausted;
  } catch (err) {
    if (err instanceof MemoryCapabilityError) {
      return "backend_unsupported";
    }
    deps.logger.warn("memory-highlights: regeneration skipped (fact listing failed)");
    return "error";
  }

  if (partial) {
    // Counts only: never the group, ids or content.
    deps.logger.warn(
      `memory-highlights: generation built from a partial fact list (facts_read=${facts.length})`,
    );
  }
  const result = await deps.generate(facts);
  if (result.state === "unavailable" && (before.state === "ready" || before.state === "empty")) {
    deps.logger.info("memory-highlights: regeneration failed; previous highlights kept");
    return "kept_previous";
  }
  const written = await deps.store.put(
    groupId,
    {
      state: result.state,
      payload: result.state === "ready" ? result.highlights : [],
      coverage: { partial, factsRead: facts.length },
    },
    startedAt,
    before.epoch,
  );
  if (!written) {
    deps.logger.info("memory-highlights: regeneration superseded (row changed during the run)");
    return "superseded";
  }
  return result.state;
}
