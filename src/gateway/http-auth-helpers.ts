import type { IncomingMessage, ServerResponse } from "node:http";
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
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(params.res, authResult);
  }
  return authResult;
}
