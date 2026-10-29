import { MemoryCapabilityError, type MemoryFactSurface } from "../client.js";
import { forgetOwnedFacts } from "../owned-forget.js";
import type { RecallStore } from "../recall-store.js";
import type { ReceiptLedger } from "../receipts.js";
import type { HighlightStore } from "./store.js";

export type RemoveReason =
  | "not_found"
  | "store_error"
  | "misconfigured"
  | "in_progress"
  | "rate_limited";

export type RemoveResult = {
  status: "SUCCEEDED" | "FAILED";
  retryable: boolean;
  reasons: RemoveReason[];
  removed_facts: number;
};

export type RemoveDeps = {
  store: Pick<HighlightStore, "get" | "dropCiting">;
  client: MemoryFactSurface;
  ledger: Pick<ReceiptLedger, "entryHashesForEpisodes" | "addTombstones">;
  recall: Pick<RecallStore, "deleteCitingFacts"> | null;
  logger: { info: (m: string) => void; warn: (m: string) => void };
};

const failed = (reason: RemoveReason, retryable: boolean): RemoveResult => ({
  status: "FAILED",
  retryable,
  reasons: [reason],
  removed_facts: 0,
});

/**
 * Remove one of the user's highlights (A&D §4.7). The caller holds the group lock
 * and has verified the user. In order, each step safe to repeat:
 *   1. find it in THIS group's cache (absent: not_found, an idempotent success);
 *   2. tombstone the source facts' receipted entries, then delete the facts,
 *      owned ones only (forgetOwnedFacts; a tombstone failure deletes nothing);
 *   3. delete recall records citing them;
 *   4. drop every cached highlight citing them and mark the row stale. This is
 *      LAST, so any earlier failure leaves the highlight in place for a retry.
 * Logs counts only.
 */
export async function removeHighlight(
  groupId: string,
  highlightId: string,
  deps: RemoveDeps,
): Promise<RemoveResult> {
  try {
    const row = await deps.store.get(groupId);
    const target = row?.payload.find((h) => h.id === highlightId);
    if (!target) {
      return { status: "SUCCEEDED", retryable: false, reasons: ["not_found"], removed_facts: 0 };
    }
    const factIds = [...new Set(target.sources.map((s) => s.fact_id))];

    let tombstoned = 0;
    let untracked = 0;
    const r = await forgetOwnedFacts(deps.client, groupId, factIds, {
      beforeDelete: async (owned) => {
        const episodes = [...new Set(owned.flatMap((f) => f.episodeIds))];
        const found = await deps.ledger.entryHashesForEpisodes(groupId, episodes);
        if (found.hashes.length > 0) {
          await deps.ledger.addTombstones(groupId, found.hashes);
        }
        tombstoned = found.hashes.length;
        untracked = found.untracked;
      },
    });
    await deps.recall?.deleteCitingFacts(groupId, factIds);
    const dropped = await deps.store.dropCiting(groupId, factIds);

    deps.logger.info(
      `memory-highlights: remove SUCCEEDED facts_deleted=${r.deleted} facts_absent=${r.absent} ` +
        `not_owned=${r.notOwned} highlights_dropped=${dropped} tombstoned=${tombstoned} ` +
        `untracked_episodes=${untracked}`,
    );
    return { status: "SUCCEEDED", retryable: false, reasons: [], removed_facts: r.deleted };
  } catch (err) {
    if (err instanceof MemoryCapabilityError) {
      deps.logger.warn(
        "memory-highlights: remove FAILED reason=misconfigured (backend cannot list facts)",
      );
      return failed("misconfigured", false);
    }
    deps.logger.warn("memory-highlights: remove FAILED reason=store_error");
    return failed("store_error", true);
  }
}
