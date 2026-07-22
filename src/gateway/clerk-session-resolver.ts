/**
 * The REAL Clerk-backed session resolver (A&D §7.4b-A). Kept separate from the
 * pure decision logic (`clerk-session-validation.ts`) so that logic stays fully
 * unit-testable with no network, while this thin adapter is the only piece that
 * touches the wire. The QA harness injects THIS (real Clerk) or a fake resolver
 * of the same `ClerkSessionResolver` shape.
 *
 * Clerk backend contract: GET https://api.clerk.com/v1/sessions/{id} with
 * `Authorization: Bearer <secret>` → 200 `{ status, user_id }` where status ∈
 * {active, revoked, expired, ended, removed, abandoned, replaced}. Anything not
 * `active` is treated as `revoked` (consent-kill). 404 → not_found. 5xx / network
 * error / timeout → unreachable (fail-open at the decision layer). The SECRET is
 * never logged.
 */

import type { ClerkSessionResolver, ResolvedSession } from "./clerk-session-validation.js";

export type ClerkBackendConfig = {
  /** Clerk backend secret (sk_test_/sk_live_). Sourced at runtime; never logged. */
  secretKey: string;
  /** Backend API base. Override for tests; defaults to the real Clerk host. */
  apiBaseUrl?: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_API_BASE = "https://api.clerk.com";
const DEFAULT_TIMEOUT_MS = 4_000;

/** Clerk session statuses that mean "not usable" → collapse to `revoked`. */
const DEAD_STATUSES = new Set(["revoked", "expired", "ended", "removed", "abandoned", "replaced"]);

export function createClerkSessionResolver(config: ClerkBackendConfig): ClerkSessionResolver {
  const base = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;

  return async (sessionId: string): Promise<ResolvedSession> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
      });

      if (res.status === 404) {
        return { status: "not_found" };
      }
      // Auth/config errors and 5xx are NOT "revoked" — treat as unreachable so a
      // misconfig or outage fails OPEN loudly rather than locking everyone out.
      if (res.status === 401 || res.status === 403 || res.status >= 500) {
        return { status: "unreachable" };
      }
      if (!res.ok) {
        return { status: "unreachable" };
      }

      const body = (await res.json()) as { status?: unknown; user_id?: unknown };
      const status = typeof body.status === "string" ? body.status : "";
      const userId = typeof body.user_id === "string" ? body.user_id : "";

      if (status === "active" && userId) {
        return { status: "active", userId };
      }
      if (DEAD_STATUSES.has(status)) {
        return { status: "revoked" };
      }
      // Unknown/absent status with a 200 → treat conservatively as revoked
      // (fail-closed on ambiguity from a REACHED Clerk; only unreachability
      // fails open).
      return { status: "revoked" };
    } catch {
      // AbortError (timeout) or network error → unreachable.
      return { status: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  };
}
