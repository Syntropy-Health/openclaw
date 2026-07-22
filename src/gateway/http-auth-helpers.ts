import type { IncomingMessage, ServerResponse } from "node:http";
import { logError, logInfo, logWarn } from "../logger.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

/**
 * Authorize a gateway bearer request. On failure, writes the auth-failure
 * response and returns `{ ok: false }`. On success, returns the full auth result
 * so callers (the chat path) can read the verified `externalId` (Clerk `sub`)
 * to derive the server-side `user_scope`.
 */
export async function authorizeGatewayBearerRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  const token = getBearerToken(params.req);
  const authResult = await authorizeGatewayConnect({
    auth: params.auth,
    connectAuth: token ? { token, password: token } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    rateLimiter: params.rateLimiter,
    // §7.4b-A: wire the session-validation logger + metric so every revocation
    // DECISION (revoked / sub-mismatch / no-handle / fail-open) is an OBSERVABLE
    // server-side line — required for the QA evidence bundle, and so a
    // misconfigured/inert path can never be silent.
    sessionLogger: { info: logInfo, warn: logWarn, error: logError },
    sessionMetric: (name) => logInfo(`[metric] ${name}`),
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(params.res, authResult);
  }
  return authResult;
}
