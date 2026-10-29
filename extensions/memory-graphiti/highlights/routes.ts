/**
 * Highlights HTTP routes (A&D §1a, §1b, §4.9). Same auth as forget and recall:
 * the user is the token's VERIFIED sub; the group is derived server-side, and no
 * route reads a user, group or email from the request. `cache-control: no-store`.
 *
 *   GET  /gateway/memory/highlights          → 200 the cached highlights (never
 *        blocks on generation; with no cache row it queues one and answers
 *        `unavailable` with the user's raw recent facts and `stale: true`)
 *   POST /gateway/memory/highlights/remove   → 200 { status: SUCCEEDED | FAILED, … }
 *
 * Logs carry states, reasons and counts only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryCapabilityError, type MemoryFactSurface } from "../client.js";
import { authenticateClerk, sendJson, type ClerkRouteAuthDeps } from "../route-auth.js";
import { recentFacts } from "./generate.js";
import type { RemoveResult } from "./remove.js";
import type { HighlightStore } from "./store.js";
import type { Highlight, HighlightSource } from "./types.js";

export const HIGHLIGHTS_ROUTE_PATH = "/gateway/memory/highlights";
export const REMOVE_HIGHLIGHT_ROUTE_PATH = "/gateway/memory/highlights/remove";
export const HIGHLIGHTS_CONTRACT = "memory-highlights/1";
/** A remove request is a few dozen bytes; anything past this is refused unread. */
const MAX_BODY_BYTES = 4096;
const HIGHLIGHT_ID = /^hl_[0-9a-f]{24}$/;
/** The raw-fact fallback is reused for this long per group (bounds listFacts per user). */
export const FALLBACK_CACHE_MS = 30_000;
const FALLBACK_CACHE_MAX = 1_000;

type Reason = "backend_unsupported" | "store_error" | "summariser_error";

export type HighlightsRouteDeps = ClerkRouteAuthDeps & {
  /** Null when highlights are not enabled for this gateway: the route answers not_enabled. */
  highlights: {
    groupFor: (sub: string) => string;
    store: Pick<HighlightStore, "get">;
    client: Pick<MemoryFactSurface, "listFacts" | "capabilities">;
    /** Take an on-demand slot and start a generation; false when today's cap is used. */
    requestNow: (groupId: string) => Promise<boolean>;
  } | null;
  now?: () => number;
};

const view = (o: {
  state: "ready" | "empty" | "not_enabled" | "unavailable";
  generatedAt?: Date | null;
  stale?: boolean;
  reason?: Reason | null;
  highlights?: Highlight[];
  fallback?: HighlightSource[] | null;
}) => ({
  contract: HIGHLIGHTS_CONTRACT,
  state: o.state,
  generated_at:
    (o.state === "ready" || o.state === "empty") && o.generatedAt
      ? o.generatedAt.toISOString()
      : null,
  stale: o.stale ?? false,
  reason: o.state === "unavailable" ? (o.reason ?? null) : null,
  highlights: o.state === "ready" ? (o.highlights ?? []) : [],
  fallback_facts: o.state === "unavailable" ? (o.fallback ?? null) : null,
});

export function createHighlightsHandler(deps: HighlightsRouteDeps) {
  const now = deps.now ?? Date.now;
  // Per-group fallback cache: a user refreshing an unavailable view must not turn
  // each GET into another full fact listing at the backend.
  const fallbackCache = new Map<string, { at: number; facts: HighlightSource[] }>();
  const cachedFallback = (group: string): HighlightSource[] | undefined => {
    const hit = fallbackCache.get(group);
    if (hit && now() - hit.at < FALLBACK_CACHE_MS) {
      return hit.facts;
    }
    fallbackCache.delete(group);
    return undefined;
  };
  const rememberFallback = (group: string, facts: HighlightSource[]) => {
    if (fallbackCache.size >= FALLBACK_CACHE_MAX) {
      const oldest = fallbackCache.keys().next().value;
      if (oldest !== undefined) {
        fallbackCache.delete(oldest);
      }
    }
    fallbackCache.set(group, { at: now(), facts });
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? "").toUpperCase() !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const sub = await authenticateClerk(req, res, deps, "memory-highlights");
    if (sub === null) {
      return;
    }
    const h = deps.highlights;
    if (!h) {
      sendJson(res, 200, view({ state: "not_enabled" }));
      return;
    }
    const answer = (state: string, body: ReturnType<typeof view>) => {
      deps.logger?.info?.(`memory-highlights: GET state=${state} reason=${body.reason ?? "-"}`);
      sendJson(res, 200, body);
    };
    if (!h.client.capabilities().listFacts) {
      answer("unavailable", view({ state: "unavailable", reason: "backend_unsupported" }));
      return;
    }
    const group = h.groupFor(sub);

    let row: Awaited<ReturnType<typeof h.store.get>>;
    try {
      row = await h.store.get(group);
    } catch {
      answer("unavailable", view({ state: "unavailable", reason: "store_error" }));
      return;
    }
    if (row?.state === "ready" && row.payload.length > 0) {
      answer(
        "ready",
        view({
          state: "ready",
          generatedAt: row.generatedAt,
          stale: row.staleSince !== null,
          highlights: row.payload,
        }),
      );
      return;
    }
    if (row?.state === "empty") {
      answer(
        "empty",
        view({ state: "empty", generatedAt: row.generatedAt, stale: row.staleSince !== null }),
      );
      return;
    }

    // No row yet, or the last generation failed: serve the raw recent facts (F3)
    // and queue a generation, unless the backend cannot list facts at all.
    let fallback: HighlightSource[] | null = cachedFallback(group) ?? null;
    if (!fallback) {
      try {
        fallback = recentFacts((await h.client.listFacts(group, { includeInvalid: false })).facts);
        rememberFallback(group, fallback);
      } catch (err) {
        if (err instanceof MemoryCapabilityError) {
          answer("unavailable", view({ state: "unavailable", reason: "backend_unsupported" }));
          return;
        }
        fallback = null;
      }
    }
    let queued: boolean;
    try {
      queued = await h.requestNow(group);
    } catch {
      // Could not even record the request: a store failure, said as such.
      answer("unavailable", view({ state: "unavailable", reason: "store_error", fallback }));
      return;
    }
    // Pending = a generation was just queued, or one is already marked (a claim
    // marks the row stale, so this holds across instances).
    const pending = queued || (row?.staleSince ?? null) !== null;
    answer(
      "unavailable",
      view({
        state: "unavailable",
        stale: pending,
        // unavailable + reason null + stale:true means "generation pending" (A&D §1a).
        // Not pending and no slot left: the last generation failed.
        reason: pending ? null : "summariser_error",
        fallback,
      }),
    );
  };
}

// ---- remove -------------------------------------------------------------------

export type RemoveRouteDeps = ClerkRouteAuthDeps & {
  /** Null when highlights are not enabled: FAILED misconfigured. */
  remove: {
    groupFor: (sub: string) => string;
    /** removeHighlight under the group lock. */
    run: (groupId: string, highlightId: string) => Promise<RemoveResult>;
  } | null;
  /** Minimum gap between two removes for the same user. Default 5 s. */
  cooldownMs?: number;
  now?: () => number;
};

const removeBody = (r: Omit<RemoveResult, "status"> & { status: RemoveResult["status"] }) => ({
  contract: HIGHLIGHTS_CONTRACT,
  status: r.status,
  retryable: r.retryable,
  reasons: r.reasons,
  removed_facts: r.removed_facts,
});

const failed = (reason: RemoveResult["reasons"][number], retryable: boolean) =>
  removeBody({ status: "FAILED", retryable, reasons: [reason], removed_facts: 0 });

/** The request body, or "too_large" once it passes MAX_BODY_BYTES (reading stops). */
function readBody(req: IncomingMessage): Promise<string | "too_large"> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Promise.resolve("too_large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) {
        return;
      }
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        resolve("too_large");
        // Stop the upload, not just the buffering.
        req.destroy?.();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

function highlightIdFrom(raw: string): string | null {
  try {
    const v = (JSON.parse(raw) as { highlight_id?: unknown })?.highlight_id;
    return typeof v === "string" && HIGHLIGHT_ID.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function createRemoveHighlightHandler(deps: RemoveRouteDeps) {
  const running = new Set<string>();
  const lastDone = new Map<string, number>();
  const cooldown = deps.cooldownMs ?? 5_000;
  const now = deps.now ?? Date.now;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const sub = await authenticateClerk(req, res, deps, "memory-highlights-remove");
    if (sub === null) {
      return;
    }
    if (!deps.remove) {
      // Same answer whatever the body: a disabled gateway never parses it.
      deps.logger?.error?.("memory-highlights-remove: FAILED reason=misconfigured (not enabled)");
      sendJson(res, 200, failed("misconfigured", false));
      return;
    }
    const remove = deps.remove;
    let raw: string | "too_large";
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    if (raw === "too_large") {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    const id = highlightIdFrom(raw);
    if (!id) {
      // Cannot be any user's highlight: an idempotent not_found, with no store work.
      sendJson(
        res,
        200,
        removeBody({
          status: "SUCCEEDED",
          retryable: false,
          reasons: ["not_found"],
          removed_facts: 0,
        }),
      );
      return;
    }
    if (running.has(sub)) {
      sendJson(res, 200, failed("in_progress", true));
      return;
    }
    const last = lastDone.get(sub);
    if (last !== undefined && now() - last < cooldown) {
      sendJson(res, 200, failed("rate_limited", true));
      return;
    }
    running.add(sub);
    let r: RemoveResult;
    try {
      r = await remove.run(remove.groupFor(sub), id);
    } catch {
      r = { status: "FAILED", retryable: true, reasons: ["store_error"], removed_facts: 0 };
    } finally {
      running.delete(sub);
      lastDone.set(sub, now());
    }
    deps.logger?.info?.(
      `memory-highlights-remove: ${r.status} reasons=${r.reasons.join(",") || "-"} removed_facts=${r.removed_facts}`,
    );
    sendJson(res, 200, removeBody(r));
  };
}
