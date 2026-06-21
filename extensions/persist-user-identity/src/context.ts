/**
 * Identity context formatting — the prependContext blocks the before_agent_start
 * hook injects. Extracted from index.ts (oc-hygiene #6) so the register() wiring
 * stays thin and these pure formatters are unit-testable without a DB.
 *
 * DOWNSTREAM CONTRACT: Other plugins (memory-gate, graphiti, etc.) parse the
 * [USER_IDENTITY] block from the system prompt to extract the canonical user_id.
 */

import type { ResolvedIdentity } from "./db.js";

/**
 * Format the identity block injected into prependContext for a resolved user.
 *
 * Format:
 *   [USER_IDENTITY]
 *   user_id: <uuid>
 *   external_id: <string|none>
 *   name: <first last>
 *   channel: <channel>
 *   channel_peer_id: <id>
 *   verified: <true|false>
 *   status: <verified|registered|new_session>
 *   [/USER_IDENTITY]
 */
export function formatIdentityContext(
  identity: ResolvedIdentity,
  status: "verified" | "registered" | "new_session",
): string {
  const name =
    identity.first_name || identity.last_name
      ? `${identity.first_name ?? ""} ${identity.last_name ?? ""}`.trim()
      : "unknown";
  return [
    "[USER_IDENTITY]",
    `user_id: ${identity.id}`,
    `external_id: ${identity.external_id ?? "none"}`,
    `name: ${name}`,
    `channel: ${identity.channel}`,
    `channel_peer_id: ${identity.channel_peer_id}`,
    `verified: ${identity.verified}`,
    `status: ${status}`,
    "[/USER_IDENTITY]",
  ].join("\n");
}

/**
 * Format the identity block for an unregistered peer — flags the agent to begin
 * the identify/register flow.
 */
export function formatUnknownUserContext(channel: string, peerId: string): string {
  return [
    "[USER_IDENTITY]",
    "user_id: none",
    "external_id: none",
    "name: unknown",
    `channel: ${channel}`,
    `channel_peer_id: ${peerId}`,
    "verified: false",
    "status: unregistered",
    "gate_eligible: true",
    "[/USER_IDENTITY]",
    "",
    "This user is not registered. Ask for their first and last name.",
    "They can type: !identify <first_name> <last_name> to find their account,",
    "then verify with a 6-digit passcode from the Syntropy Journals app.",
    "Alternatively: !register <first_name> <last_name> for a basic account.",
  ].join("\n");
}
