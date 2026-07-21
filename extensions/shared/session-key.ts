/**
 * Canonical session-key parsing shared by the Syntropy identity extensions.
 *
 * OpenClaw session keys encode the channel and peer identity:
 *   agent:<sessionId>:<channel>:<...peer-parts>
 *   agent:<sessionId>:<channel>:direct:<peer-id>      (direct conversation form)
 *   agent:<sessionId>:main                            (shared — no peer)
 *
 * Examples (from the 15 channel adapters):
 *   agent:abc:whatsapp:direct:+15551234567
 *   agent:abc:imessage:direct:user@example.com
 *   agent:abc:line:direct:U1234567890
 *   agent:abc:discord:guild-123:channel-456
 *   agent:abc:slack:T01:C02:U03
 *
 * This module is the single source of truth for the parsing convention. It was
 * previously copy-pasted (byte-identical logic, drifting only in code style)
 * into persist-user-identity, auth-memory-gate, and syntropy — those now
 * re-export / import from here so the convention can never drift across the
 * three identity-resolving hooks (oc-hygiene #7).
 */

/** Channel name from a session key, or "unknown" when the key isn't in the expected form. */
export function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts[2];
  }
  return "unknown";
}

/**
 * Extract the peer-specific portion of a session key, with the `direct:`
 * marker stripped when present.
 *
 * Session key formats:
 *   agent:{agentId}:direct:{peerId}
 *   agent:{agentId}:{channel}:direct:{peerId}
 *   agent:{agentId}:{channel}:{peerId...}
 *   agent:{agentId}:main  (shared — no peer)
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
 * The canonical identity peer for a hook ctx (G-lane [G1], A&D §7).
 *
 * Prefers `ctx.deviceId` (the `X-OpenClaw-Device-Id` header the host threads on
 * the hook ctx — shrinemobile's stable install-UUID) over the session-key-derived
 * peer: the HTTP session key partitions by USER scope (`openresponses-user:<sub>`
 * plus a volatile conversation hint), so its derived "peer" is neither stable nor
 * a device — while `lp_user_channels.channel_peer_id` for the mobile channel is
 * PINNED to the device id (auto-bind writes it, sign-out unbind deletes it).
 * Both identity hooks (persist-user-identity, auth-memory-gate) MUST derive the
 * peer through this ONE function so bind, gate-lookup, and unbind can never
 * disagree (oc-hygiene #7: single source of truth).
 */
export function deriveIdentityPeer(ctx?: {
  sessionKey?: string;
  deviceId?: string | null;
}): string {
  const deviceId = ctx?.deviceId?.trim();
  if (deviceId) {
    return deviceId;
  }
  return derivePeerId(ctx?.sessionKey ?? "");
}
