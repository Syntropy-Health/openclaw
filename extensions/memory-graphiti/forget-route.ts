/**
 * `POST /gateway/memory/forget` — self-service "Clear chat memory" (CTO #17002;
 * CEO-approved). SJ shows "cleared" only when its own delete AND this call both
 * report success.
 *
 * Flow (fail-closed at every step, mirroring /gateway/mobile/signout):
 *   POST only → 405 · Bearer Clerk JWT verified by the gateway's Clerk path
 *   (missing / invalid / expired / Clerk unconfigured → 401) · the user is the
 *   token's VERIFIED `sub` — the request carries no user id and none is read ·
 *   erase (forgetByExternalId) · 200 with a DEFINITE outcome:
 *     { status: "SUCCEEDED" | "FAILED", retryable, reasons, counts }
 *   SUCCEEDED only when the store group(s), receipts and every transcript of the
 *   user are gone. Idempotent: a repeat call is SUCCEEDED with zero counts.
 *
 * Logs carry the outcome and counts only — never the sub, a group id or content.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { forgetOutcome, type ForgetResult } from "./forget.js";
import { authenticateClerk, sendJson, type ClerkRouteAuthDeps } from "./route-auth.js";

export const FORGET_ROUTE_PATH = "/gateway/memory/forget";

export type ForgetRouteDeps = ClerkRouteAuthDeps & {
  /** Minimum gap between two erases for the same user (abuse guard). Default 5 s. */
  cooldownMs?: number;
  now?: () => number;
  /** Null when memory is refused (e.g. no pepper under the PHI approval): the erase cannot target the right groups. */
  forget: ((externalId: string) => Promise<ForgetResult>) | null;
};

const failed = (reasons: string[], retryable: boolean) => ({
  status: "FAILED",
  retryable,
  reasons,
  counts: null,
});

export function createForgetHandler(deps: ForgetRouteDeps) {
  // Per-user single-flight + cooldown: an erase scans every transcript, so one
  // valid account must not be able to loop it against the shared event loop.
  const running = new Set<string>();
  const lastDone = new Map<string, number>();
  const cooldown = deps.cooldownMs ?? 5_000;
  const now = deps.now ?? Date.now;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const sub = await authenticateClerk(req, res, deps, "memory-forget");
    if (sub === null) {
      return;
    }
    if (running.has(sub)) {
      sendJson(res, 200, failed(["in_progress"], true));
      return;
    }
    const last = lastDone.get(sub);
    if (last !== undefined && now() - last < cooldown) {
      sendJson(res, 200, failed(["rate_limited"], true));
      return;
    }
    if (!deps.forget) {
      deps.logger?.error?.("memory-forget: FAILED reason=misconfigured (memory refused)");
      sendJson(res, 200, failed(["misconfigured"], false));
      return;
    }
    let r: ForgetResult;
    running.add(sub);
    try {
      r = await deps.forget(sub);
    } catch (err) {
      const misconfigured = (err as { code?: string }).code === "misconfigured";
      deps.logger?.error?.(
        `memory-forget: FAILED reason=${misconfigured ? "misconfigured" : "store_error"}`,
      );
      sendJson(res, 200, failed([misconfigured ? "misconfigured" : "store_error"], !misconfigured));
      return;
    } finally {
      running.delete(sub);
      lastDone.set(sub, now());
    }
    const outcome = forgetOutcome(r);
    const counts = {
      storeGroupsDeleted: r.storeGroupsDeleted,
      storeGroupsAbsent: r.storeGroupsAbsent,
      receipts: r.receipts,
      transcripts: r.transcripts,
    };
    deps.logger?.info?.(
      `memory-forget: ${outcome.status} reasons=${outcome.reasons.join(",") || "-"} ` +
        `groupsDeleted=${counts.storeGroupsDeleted} receipts=${counts.receipts} transcripts=${counts.transcripts}`,
    );
    sendJson(res, 200, { ...outcome, counts });
  };
}
