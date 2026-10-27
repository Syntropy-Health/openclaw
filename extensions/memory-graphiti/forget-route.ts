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
import type { ResolvedClerkAuth } from "../../src/gateway/auth.js";
import { forgetOutcome, type ForgetResult } from "./forget.js";

export const FORGET_ROUTE_PATH = "/gateway/memory/forget";

export type ForgetRouteDeps = {
  resolveClerk: () => ResolvedClerkAuth | undefined;
  verifyJwt: (
    token: string,
    clerk: ResolvedClerkAuth,
  ) => Promise<{ ok: true; externalId: string } | { ok: false }>;
  /** Null when memory is refused (e.g. no pepper under the PHI approval): the erase cannot target the right groups. */
  forget: ((externalId: string) => Promise<ForgetResult>) | null;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
};

function bearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || undefined;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const failed = (reasons: string[], retryable: boolean) => ({
  status: "FAILED",
  retryable,
  reasons,
  counts: null,
});

export function createForgetHandler(deps: ForgetRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const clerk = deps.resolveClerk();
    const token = bearerToken(req);
    if (!clerk || !token) {
      deps.logger?.warn?.(
        `memory-forget: 401 reason=${!clerk ? "clerk-not-configured" : "no-bearer"}`,
      );
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let verified: Awaited<ReturnType<ForgetRouteDeps["verifyJwt"]>>;
    try {
      verified = await deps.verifyJwt(token, clerk);
    } catch {
      verified = { ok: false };
    }
    if (!verified.ok || !verified.externalId) {
      deps.logger?.warn?.("memory-forget: 401 reason=invalid-token");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!deps.forget) {
      deps.logger?.error?.("memory-forget: FAILED reason=misconfigured (memory refused)");
      sendJson(res, 200, failed(["misconfigured"], false));
      return;
    }
    let r: ForgetResult;
    try {
      r = await deps.forget(verified.externalId);
    } catch {
      deps.logger?.error?.("memory-forget: FAILED reason=store_error");
      sendJson(res, 200, failed(["store_error"], true));
      return;
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
