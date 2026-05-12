/**
 * Session-key parsing for the Syntropy extension.
 *
 * OpenClaw session keys encode the channel and peer identity:
 *   agent:<sessionId>:<channel>:<...peer-parts>
 *   agent:<sessionId>:<channel>:direct:<peer-id>      (direct conversation form)
 *
 * Examples (from the 15 channel adapters):
 *   agent:abc:whatsapp:direct:+15551234567
 *   agent:abc:imessage:direct:user@example.com
 *   agent:abc:line:direct:U1234567890
 *   agent:abc:discord:guild-123:channel-456
 *   agent:abc:slack:T01:C02:U03
 *
 * Extracted from `index.ts` so the parsing logic can be unit-tested in
 * isolation without spinning up the full plugin.
 */

/** Channel name from a session key, or "unknown" when the key isn't in the expected form. */
export function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts.length >= 3 && parts[0] === "agent" ? parts[2] : "unknown";
}

/** Peer-id portion of a session key, with the `direct:` marker stripped when present. */
export function derivePeerId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return sessionKey;
  const rest = parts.slice(2);
  const directIdx = rest.indexOf("direct");
  if (directIdx >= 0 && directIdx < rest.length - 1) return rest.slice(directIdx + 1).join(":");
  return rest.length >= 2 ? rest.slice(1).join(":") : (rest[0] ?? sessionKey);
}
