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
    // No channel_peer_id (mono #542): no consumer reads it from this block (9
    // places checked, 0 readers), and it put the phone into the LLM context and
    // the session transcript on every verified turn.
    `verified: ${identity.verified}`,
    `status: ${status}`,
    "[/USER_IDENTITY]",
  ].join("\n");
}

/**
 * Format the identity block for an unregistered peer — flags the agent to begin
 * the identify/register flow.
 */
// No channel_peer_id here (mono #541): this block rides the same gated turn as
// [IDENTITY_GATE] and goes to the LLM provider; on SMS/WhatsApp the peer is a phone.
export function formatUnknownUserContext(channel: string): string {
  return [
    "[USER_IDENTITY]",
    "user_id: none",
    "external_id: none",
    "name: unknown",
    `channel: ${channel}`,
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
