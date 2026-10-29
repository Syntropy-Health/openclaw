/**
 * `GET /gateway/memory/recall?turn=<response_id>` (A&D §1c, R10 panel): exactly
 * the facts injected into the agent for that turn — the stored result of the
 * turn's one searchRanked call (RecallStore), never a second search.
 *
 *   GET only → 405 · same auth as POST /gateway/memory/forget (401 otherwise) ·
 *   the user is the token's VERIFIED sub; its group is derived server-side ·
 *   `turn` omitted = this user's latest turn · another user's turn id = `none`
 *   (never 403, so turn ids cannot be probed) · `cache-control: no-store`.
 *
 *   200 { contract: "memory-highlights/1",
 *         state: "ready" | "none" | "not_enabled" | "timed_out",
 *         turn: string | null,
 *         items: [{ rank, fact_id, fact, last_seen, highlight_id }] }
 *
 * Logs carry the state only — never the sub, a group id, a turn id or content.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecallRecord, RecallStore } from "./recall-store.js";
import { authenticateClerk, sendJson, type ClerkRouteAuthDeps } from "./route-auth.js";

export const RECALL_ROUTE_PATH = "/gateway/memory/recall";
export const RECALL_CONTRACT = "memory-highlights/1";
/** Longer than any response id; a longer value is treated as unknown. */
const MAX_TURN_CHARS = 200;

export type RecallRouteDeps = ClerkRouteAuthDeps & {
  /**
   * The store and the verified sub → opaque group mapping. Null when memory is
   * not enabled or refused (no identity DB, no pepper under the approval, recall
   * off): the route then answers `not_enabled` after auth.
   */
  recall: { store: RecallStore; groupFor: (sub: string) => string } | null;
};

function turnParam(req: IncomingMessage): { turn: string | null; tooLong: boolean } {
  const raw = new URL(req.url ?? "/", "http://gateway.local").searchParams.get("turn")?.trim();
  if (!raw) {
    return { turn: null, tooLong: false };
  }
  return raw.length > MAX_TURN_CHARS
    ? { turn: null, tooLong: true }
    : { turn: raw, tooLong: false };
}

const body = (state: string, turn: string | null, record?: RecallRecord | null) => ({
  contract: RECALL_CONTRACT,
  state,
  turn,
  // Key order is part of the contract. highlight_id joins the highlight cache (PR-2).
  items: (record?.items ?? []).map((i) => ({
    rank: i.rank,
    fact_id: i.fact_id,
    fact: i.fact,
    last_seen: i.last_seen,
    highlight_id: null,
  })),
});

export function createRecallHandler(deps: RecallRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? "").toUpperCase() !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const sub = await authenticateClerk(req, res, deps, "memory-recall");
    if (sub === null) {
      return;
    }
    const { turn, tooLong } = turnParam(req);
    if (!deps.recall) {
      sendJson(res, 200, body("not_enabled", turn));
      return;
    }
    if (tooLong) {
      sendJson(res, 200, body("none", null));
      return;
    }
    let record: RecallRecord | null;
    try {
      const group = deps.recall.groupFor(sub);
      record = turn
        ? await deps.recall.store.read(group, turn)
        : await deps.recall.store.latest(group);
    } catch {
      deps.logger?.error?.("memory-recall: 503 reason=store_error");
      sendJson(res, 503, { contract: RECALL_CONTRACT, error: "unavailable" });
      return;
    }
    if (!record) {
      sendJson(res, 200, body("none", turn));
      return;
    }
    sendJson(res, 200, body(record.state, record.turnId, record));
  };
}
