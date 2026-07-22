/**
 * G-lane [G2]: `POST /gateway/mobile/signout` — the mobile sign-out UNBIND
 * endpoint (A&D §7). The app calls it WHILE still holding a valid Clerk JWT
 * (strict app-side order: unbind → Clerk signOut → token clear).
 *
 * Flow (fail-closed at every step):
 *   POST only → 405 · Bearer JWT verified via the gateway's Clerk path
 *   (missing/invalid/expired → 401; Clerk unconfigured → 401 by absence) ·
 *   `X-OpenClaw-Device-Id` required → 400 · DELETE exactly the caller's OWN
 *   `(shrinemobile, device-id)` link row (ownership enforced in SQL — a row
 *   belonging to another user is untouched, and indistinguishable from absent:
 *   no probing signal) · deny the JWT's `sid` ([G2b] replay window) · 200.
 *
 * Idempotent: absent/already-unbound → 200 no-op; unbind twice → 200 both (the
 * deny-list is NOT consulted here — only the chat path rejects revoked sids).
 *
 * The route registers via `api.registerHttpRoute` (extension-owned — this
 * plugin owns the pg client + schema); Clerk verify helpers are imported from
 * the gateway per the established extension→src convention (kapso precedent).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedClerkAuth } from "../../../src/gateway/auth.js";

/** The channel this endpoint unbinds — pinned by the A&D (mobile only). */
export const SIGNOUT_CHANNEL = "shrinemobile";

export const SIGNOUT_ROUTE_PATH = "/gateway/mobile/signout";

export type SignoutRouteDeps = {
  /** Resolve the gateway Clerk config per request (undefined → 401 by absence). */
  resolveClerk: () => ResolvedClerkAuth | undefined;
  /** Verify the bearer (the gateway's authorizeClerkJwt; injectable for tests). */
  verifyJwt: (
    token: string,
    clerk: ResolvedClerkAuth,
  ) => Promise<{ ok: true; externalId: string; sid?: string } | { ok: false }>;
  /** Delete the caller's own (channel, device) link row; returns rows deleted. */
  unlink: (params: {
    externalId: string;
    channel: string;
    channelPeerId: string;
  }) => Promise<number>;
  /** Deny the session id ([G2b]); injectable for tests. */
  denySession: (sid: string) => void;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
};

function bearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Node handler factory — testable with injected deps (no network, no pg). */
export function createMobileSignoutHandler(deps: SignoutRouteDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // ── OBSERVABILITY (T1.2.2 post-mortem) ──────────────────────────────────
    // Every outcome below is logged, not just success. Rationale, learned the
    // hard way: after a live sign-out the link row was still present, and it was
    // IMPOSSIBLE to tell server-side whether the app never called this route or
    // called it and was rejected — because v1 logged ONLY the success path and
    // the gateway logs no HTTP requests at all. A route whose failures are
    // invisible is the same "silent control reports success" defect we keep
    // hitting: a best-effort client sees its own green while the server did
    // nothing. `unbind attempt` is emitted on ARRIVAL so a call is provable even
    // when it is later rejected. NEVER log the token (only its presence).
    deps.logger?.info?.(
      `mobile-signout: unbind attempt method=${(req.method ?? "").toUpperCase()} ` +
        `bearer=${bearerToken(req) ? "present" : "absent"} ` +
        `deviceIdHeader=${headerValue(req, "x-openclaw-device-id") ? "present" : "absent"}`,
    );

    if ((req.method ?? "").toUpperCase() !== "POST") {
      deps.logger?.warn?.(
        `mobile-signout: REJECTED 405 reason=wrong-method method=${(req.method ?? "").toUpperCase()} — NO unbind performed`,
      );
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // Fail-closed auth: no Clerk config → no verified mobile path → 401.
    const clerk = deps.resolveClerk();
    const token = bearerToken(req);
    if (!clerk || !token) {
      deps.logger?.warn?.(
        `mobile-signout: REJECTED 401 reason=${!clerk ? "clerk-not-configured" : "no-bearer"} — NO unbind performed`,
      );
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let verified: Awaited<ReturnType<SignoutRouteDeps["verifyJwt"]>>;
    let verifyThrew = false;
    try {
      verified = await deps.verifyJwt(token, clerk);
    } catch {
      verified = { ok: false };
      verifyThrew = true;
    }
    if (!verified.ok) {
      deps.logger?.warn?.(
        `mobile-signout: REJECTED 401 reason=${verifyThrew ? "verify-threw" : "invalid-token"} — NO unbind performed`,
      );
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const deviceId = headerValue(req, "x-openclaw-device-id");
    if (!deviceId) {
      // Token was VALID — so this is a client that authenticated and still could
      // not be unbound. Loudest of the rejections: it means a real sign-out
      // silently left the link in place (see the ordering requirement in
      // A&D §7.4b-A: revocation must not depend on unrelated input).
      deps.logger?.warn?.(
        "mobile-signout: REJECTED 400 reason=missing-device-id (token WAS valid) — NO unbind performed",
      );
      sendJson(res, 400, { error: "missing X-OpenClaw-Device-Id" });
      return;
    }

    // [G2b] FIRST: close the replay window — deny this session id (chat path
    // rejects it → 401 → no agent turn → no re-bind). Denying BEFORE the DB
    // unlink means consent-kill holds even when the unlink 500s (the client
    // retries sign-out; the session is already dead either way). Also runs on a
    // no-op unbind so a second sign-out still revokes a still-live session.
    if (verified.sid) {
      deps.denySession(verified.sid);
    }

    // Ownership enforced in SQL: only the caller's own link row can match.
    let unbound = 0;
    try {
      unbound = await deps.unlink({
        externalId: verified.externalId,
        channel: SIGNOUT_CHANNEL,
        channelPeerId: deviceId,
      });
    } catch (err) {
      deps.logger?.error?.(`mobile-signout: unlink failed: ${String(err)}`);
      sendJson(res, 500, { error: "unbind failed" });
      return;
    }

    // Success path logs the ROW COUNT, not a boolean: "200 rowsDeleted=0" is the
    // signature of a real-but-ineffective unbind (device-id mismatch, already
    // unbound, or another user's row) — indistinguishable from a true no-op in
    // the response body, which returns 200 either way by idempotency design.
    // That number is what makes an ineffective unbind diagnosable at all.
    deps.logger?.info?.(
      `mobile-signout: OK 200 rowsDeleted=${unbound} channel=${SIGNOUT_CHANNEL}` +
        (unbound === 0 ? " (NO-OP — nothing matched this user+device)" : ""),
    );
    sendJson(res, 200, { ok: true, unbound: unbound > 0 });
  };
}
