import { MemoryCapabilityError, type MemoryFact, type MemoryFactSurface } from "../client.js";
import type { GenerateResult } from "./generate.js";
import type { HighlightStore } from "./store.js";

/** Most listFacts calls per regeneration (each call is itself bounded by the backend). */
export const LIST_PAGES_MAX = 5;

export type RegenerateOutcome =
  | "ready"
  | "empty"
  | "unavailable"
  | "kept_previous"
  | "gone"
  | "backend_unsupported"
  | "error";

export type RegenerateDeps = {
  client: Pick<MemoryFactSurface, "listFacts">;
  store: Pick<HighlightStore, "clock" | "get" | "put">;
  /** generateHighlights bound to this group, runner and rank config. */
  generate: (facts: MemoryFact[]) => Promise<GenerateResult>;
  logger: { info: (m: string) => void; warn: (m: string) => void };
};

/**
 * Regenerate one group's highlights (A&D §4.4). The caller holds the group lock.
 * Only a group that has a row is generated (claimOnDemand creates rows; a forget
 * deletes them), and the result is written with an update, so a forget always
 * wins. A failed run never replaces highlights the user already had. Logs carry
 * outcomes and counts only, never the group or error text.
 */
export async function regenerateGroup(
  groupId: string,
  deps: RegenerateDeps,
): Promise<RegenerateOutcome> {
  const before = await deps.store.get(groupId);
  if (!before) {
    return "gone";
  }
  const startedAt = await deps.store.clock();

  const facts: MemoryFact[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGES_MAX; page++) {
      const res = await deps.client.listFacts(groupId, { includeInvalid: false, cursor });
      facts.push(...res.facts);
      if (!res.nextCursor) {
        break;
      }
      cursor = res.nextCursor;
    }
  } catch (err) {
    if (err instanceof MemoryCapabilityError) {
      return "backend_unsupported";
    }
    deps.logger.warn("memory-highlights: regeneration skipped (fact listing failed)");
    return "error";
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
    },
    startedAt,
  );
  return written ? result.state : "gone";
}
