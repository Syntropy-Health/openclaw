/**
 * Shared auth for the /gateway/memory/* routes (forget, recall): a Bearer Clerk
 * JWT verified by the gateway's Clerk path, plus the server-side session check
 * when the gateway has one. The user is ALWAYS the token's verified `sub`; no
 * route reads a user id, group id or email from the request.
 *
 * Logs carry the route label and a reason only — never the sub or the token.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedClerkAuth } from "../../src/gateway/auth.js";

export type ClerkRouteAuthDeps = {
  resolveClerk: () => ResolvedClerkAuth | undefined;
  verifyJwt: (
    token: string,
    clerk: ResolvedClerkAuth,
  ) => Promise<{ ok: true; externalId: string } | { ok: false }>;
  /**
   * Server-side Clerk session check, when the gateway has a session resolver (the
   * chat path's revocation guard): a token from a signed-out / revoked session is
   * refused. Undefined = JWT-verify-only (as chat does without a resolver).
   */
  validateSession?: (sub: string, sessionId: string | undefined) => Promise<boolean>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
};

export function bearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || undefined;
}

export function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * The verified sub, or null after answering 401 {error:"unauthorized"}: missing,
 * invalid or expired token, Clerk not configured, or a session that is not live.
 */
export async function authenticateClerk(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ClerkRouteAuthDeps,
  label: string,
): Promise<string | null> {
  const clerk = deps.resolveClerk();
  const token = bearerToken(req);
  if (!clerk || !token) {
    deps.logger?.warn?.(`${label}: 401 reason=${!clerk ? "clerk-not-configured" : "no-bearer"}`);
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  let verified: Awaited<ReturnType<ClerkRouteAuthDeps["verifyJwt"]>>;
  try {
    verified = await deps.verifyJwt(token, clerk);
  } catch {
    verified = { ok: false };
  }
  if (!verified.ok || !verified.externalId) {
    deps.logger?.warn?.(`${label}: 401 reason=invalid-token`);
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  if (deps.validateSession) {
    const raw = req.headers["x-openclaw-clerk-session-id"];
    const sid = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
    let live = false;
    try {
      live = await deps.validateSession(verified.externalId, sid);
    } catch {
      live = false;
    }
    if (!live) {
      deps.logger?.warn?.(`${label}: 401 reason=session-not-active`);
      sendJson(res, 401, { error: "unauthorized" });
      return null;
    }
  }
  return verified.externalId;
}
