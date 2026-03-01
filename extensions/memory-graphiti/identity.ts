/**
 * Identity resolution for the "identity" groupIdStrategy.
 *
 * Queries the lp_users + lp_user_channels tables (created by persist-user-identity)
 * to resolve a canonical scope key from the hook context. The scope key is used as
 * the Graphiti group_id, providing cross-channel per-user memory isolation.
 */

import type postgres from "postgres";
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

  return (user.external_id as string | null) ?? (user.id as string);
}
