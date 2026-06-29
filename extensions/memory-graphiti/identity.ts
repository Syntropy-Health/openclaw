/**
 * Identity resolution for the "identity" groupIdStrategy.
 *
 * Queries the lp_users + lp_user_channels tables (created by persist-user-identity)
 * to resolve a canonical scope key from the hook context. The scope key is used as
 * the Graphiti group_id, providing cross-channel per-user memory isolation.
 */

import type postgres from "postgres";
import { deriveScopeKey } from "../shared/scope-key.js";
import type { GroupIdContext } from "./config.js";

// ---------------------------------------------------------------------------
// Session key parsing — mirrors persist-user-identity / auth-memory-gate
// ---------------------------------------------------------------------------

/**
 * Extract the channel name from a session key.
 * Format: `agent:{agentId}:{channel}:{...}`
 */
export function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts[2];
  }
  return "unknown";
}

/**
 * Extract the peer-specific portion of a session key.
 *
 * Session key formats:
 *   agent:{agentId}:direct:{peerId}
 *   agent:{agentId}:{channel}:direct:{peerId}
 *   agent:{agentId}:{channel}:{peerId...}
 *   agent:{agentId}:main  (shared session — no peer)
 */
export function derivePeerId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") {
    return sessionKey;
  }
  const rest = parts.slice(2);
  const directIdx = rest.indexOf("direct");
  if (directIdx >= 0 && directIdx < rest.length - 1) {
    return rest.slice(directIdx + 1).join(":");
  }
  if (rest.length >= 2) {
    return rest.slice(1).join(":");
  }
  return rest[0] ?? sessionKey;
}

/**
 * Prefer the verified external caller identity (e.g. the Clerk JWT `sub` for
 * HTTP chat callers) as the canonical identity-strategy scope key.
 *
 * This is the SINGLE source of truth for the HTTP/Clerk → group_id mapping,
 * called by BOTH the recall (before_agent_start) and capture (agent_end) hooks
 * so they can never drift. When present, it equals the same person's
 * lp_users.external_id on other channels — so keying on it here unifies the
 * HTTP/Clerk graph with the WhatsApp graph (#834/#836).
 *
 * Returns null when ctx carries no usable externalId (every channel caller —
 * the existing DB/derive identity path is then byte-identical).
 */
export function externalIdScopeKey(ctx: GroupIdContext): string | null {
  const externalId =
    typeof ctx.externalId === "string" && ctx.externalId.length > 0 ? ctx.externalId : null;
  if (!externalId) {
    return null;
  }
  return deriveScopeKey({ external_id: externalId, id: externalId });
}

// ---------------------------------------------------------------------------
// Identity DB query
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical scope key for a session by querying the identity DB.
 *
 * Returns `external_id` (cross-channel, from JWT `sub`) when available,
 * otherwise falls back to the internal `user_id` UUID.
 * Returns null when the peer is not registered in the identity tables.
 */
export async function resolveIdentityScopeKey(
  sql: postgres.Sql,
  ctx: GroupIdContext,
): Promise<string | null> {
  const sessionKey = ctx.sessionKey ?? "";
  const channel = ctx.messageProvider ?? deriveChannel(sessionKey);
  const peerId = derivePeerId(sessionKey);

  if (!peerId || peerId === "main" || peerId === "unknown") {
    return null;
  }

  const rows = await sql`
    SELECT u.id, u.external_id
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${peerId}
    LIMIT 1
  `;

  const user = rows[0];
  if (!user) {
    return null;
  }

  // Shared canonical derivation (single source of truth with auth-memory-gate).
  return deriveScopeKey({
    external_id: user.external_id as string | null,
    id: user.id as string,
  });
}
