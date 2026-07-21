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
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // Fail-closed auth: no Clerk config → no verified mobile path → 401.
    const clerk = deps.resolveClerk();
    const token = bearerToken(req);
    if (!clerk || !token) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let verified: Awaited<ReturnType<SignoutRouteDeps["verifyJwt"]>>;
    try {
      verified = await deps.verifyJwt(token, clerk);
    } catch {
      verified = { ok: false };
    }
    if (!verified.ok) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const deviceId = headerValue(req, "x-openclaw-device-id");
    if (!deviceId) {
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

    deps.logger?.info?.(
      `mobile-signout: unbind ${unbound > 0 ? "removed" : "no-op"} for device link`,
    );
    sendJson(res, 200, { ok: true, unbound: unbound > 0 });
  };
}
