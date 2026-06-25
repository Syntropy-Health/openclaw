import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";

/**
 * Derive the server-side L1 `user_scope` from a verified Clerk `sub`.
 *
 * This is the gateway-layer view of the settled shared resolver
 * `deriveScopeKey({ external_id, id }) = external_id ?? id` (extensions/shared/
 * scope-key.ts, #836). For a Clerk-verified chat request the `external_id` IS
 * the JWT `sub` and is always present, so the scope is exactly `sub`. It is
 * inlined here (rather than imported from the extensions layer) to avoid a
 * src → extensions layering inversion; the contract is identical by
 * construction and documented in both places.
 */
export function deriveUserScopeFromSub(sub: string | undefined): string | undefined {
  const externalId = sub?.trim();
  return externalId || undefined;
}

export function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

export function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = raw.slice(7).trim();
  return token || undefined;
}

export function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    getHeader(req, "x-openclaw-agent-id")?.trim() ||
    getHeader(req, "x-openclaw-agent")?.trim() ||
    "";
  if (!raw) {
    return undefined;
  }
  return normalizeAgentId(raw);
}

export function resolveAgentIdFromModel(model: string | undefined): string | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }

  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  const agentId = m?.groups?.agentId;
  if (!agentId) {
    return undefined;
  }
  return normalizeAgentId(agentId);
}

export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) {
    return fromHeader;
  }

  const fromModel = resolveAgentIdFromModel(params.model);
  return fromModel ?? "main";
}

export function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  /**
   * Server-derived L1 user_scope (= deriveScopeKey({external_id: sub, id: sub})
   * = the verified Clerk `sub`). When present it OVERRIDES any client-supplied
   * `user` and forces the session into the user's partition — even when the
   * client sends an `X-OpenClaw-Session-Key` (which is then threaded as an L3
   * conversation hint WITHIN that partition, never as the identity). This is the
   * unification guarantee: one Clerk user → one user_scope across consumers.
   */
  userScope?: string | undefined;
  prefix: string;
}): string {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  const scope = params.userScope?.trim();

  if (scope) {
    // L1 user_scope is authoritative. Thread the L3 session hint (if any) as a
    // suffix so turns within one conversation share a key but stay inside the
    // user's partition; the client-supplied `user` field is ignored (§5).
    const sessionHint = explicit ? `:${explicit}` : "";
    const mainKey = `${params.prefix}-user:${scope}${sessionHint}`;
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
  }

  // Legacy (non-Clerk) path — unchanged.
  if (explicit) {
    return explicit;
  }

  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}
