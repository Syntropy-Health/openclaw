import type postgres from "postgres";
import { deriveScopeKey } from "../../shared/scope-key.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScopeConfig = {
  requireVerified?: boolean;
  gateMessage?: string;
};

export type ScopeResult = {
  userId: string;
  externalId: string | null;
  scopeKey: string;
  verified: boolean;
  channel: string;
  peerId: string;
};

/** Minimal identity row from lp_users + lp_user_channels JOIN. */
type IdentityRow = {
  id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  channel: string;
  channel_peer_id: string;
  verified: boolean;
};

// ---------------------------------------------------------------------------
// Session key parsing — shared canonical module (oc-hygiene #7)
// ---------------------------------------------------------------------------

// Re-exported (not redefined) so the parsing convention stays identical across
// persist-user-identity, syntropy, and this extension — and so existing
// importers of `deriveChannel`/`derivePeerId` from "./scope.js" (index.ts,
// scope.test.ts) keep working unchanged.
export { deriveChannel, deriveIdentityPeer, derivePeerId } from "../../shared/session-key.js";

// ---------------------------------------------------------------------------
// Identity query — reads from persist-user-identity's lp_users table
// ---------------------------------------------------------------------------

/**
 * Look up a user by their channel-specific peer identifier.
 * Queries the same lp_users + lp_user_channels tables created by
 * persist-user-identity. Returns null if the peer is not registered.
 */
export async function findUserByChannelPeer(
  sql: postgres.Sql,
  channel: string,
  channelPeerId: string,
): Promise<IdentityRow | null> {
  const rows = await sql`
    SELECT u.id, u.external_id, u.first_name, u.last_name,
           uc.channel, uc.channel_peer_id,
           (u.external_id IS NOT NULL) AS verified
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${channelPeerId}
    LIMIT 1
  `;
  return (rows[0] as IdentityRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Cross-check a peer-row identity against the turn's VERIFIED caller identity
 * (G-lane security review — defense-in-depth for the [G1] auto-bind).
 *
 * The peer row is keyed by a CLIENT-supplied device id; cross-user isolation
 * must NEVER depend on the auto-bind write having succeeded first. On a
 * verified turn (`ctxExternalId` present — the server-verified Clerk `sub`),
 * a row whose `external_id` differs is STALE or CONTESTED (e.g. a device id
 * supplied by a different account while the reconciling bind write failed):
 * return `null` → the caller treats the peer as UNIDENTIFIED (fail-closed;
 * the turn is gated rather than keyed onto another user's memory scope).
 * Unverified turns (no ctxExternalId — channel callers) pass through: their
 * rows were created by the channel pairing flow, not the auto-bind.
 */
export function reconcileVerifiedIdentity(
  identity: IdentityRow | null,
  ctxExternalId: string | null | undefined,
): IdentityRow | null {
  if (!identity) {
    return null;
  }
  const verifiedSub = ctxExternalId?.trim();
  if (verifiedSub && identity.external_id !== verifiedSub) {
    return null;
  }
  return identity;
}

/**
 * Resolve the memory scope for a given session.
 * Returns null when the peer cannot be identified (shared sessions, unknown).
 */
export function resolveScope(identity: IdentityRow, channel: string, peerId: string): ScopeResult {
  // Shared canonical derivation (single source of truth with memory-graphiti):
  // prefer external_id (cross-channel, from JWT sub), fall back to user UUID.
  const scopeKey = deriveScopeKey(identity);

  return {
    userId: identity.id,
    externalId: identity.external_id,
    scopeKey,
    verified: identity.verified,
    channel,
    peerId,
  };
}

// ---------------------------------------------------------------------------
// Scope block formatting — the contract downstream memory plugins read
// ---------------------------------------------------------------------------

/**
 * Format the memory scope block injected into prependContext.
 *
 * DOWNSTREAM CONTRACT: Memory plugins (Graphiti, LanceDB, pgvector) parse
 * this block to extract the scope key for per-user memory isolation.
 *
 * Format:
 *   [MEMORY_SCOPE]
 *   scope_key: <external_id or user_id>
 *   user_id: <uuid>
 *   external_id: <string|none>
 *   verified: <true|false>
 *   gated: <true|false>
 *   [/MEMORY_SCOPE]
 */
export function formatScopeBlock(scope: ScopeResult, config: ScopeConfig): string {
  // Gate check: if requireVerified and user is not verified, return gate message
  if (config.requireVerified && !scope.verified) {
    return formatGatedMessage(config);
  }

  return [
    "[MEMORY_SCOPE]",
    `scope_key: ${scope.scopeKey}`,
    `user_id: ${scope.userId}`,
    `external_id: ${scope.externalId ?? "none"}`,
    `verified: ${scope.verified}`,
    "gated: false",
    "[/MEMORY_SCOPE]",
  ].join("\n");
}

/**
 * Format the gate message when memory retrieval is blocked for unverified users.
 */
export function formatGatedMessage(config: ScopeConfig): string {
  const customMsg = config.gateMessage?.trim();

  const lines = ["[MEMORY_SCOPE]", "gated: true", "[/MEMORY_SCOPE]", ""];

  if (customMsg) {
    lines.push(customMsg);
  } else {
    lines.push(
      "Memory retrieval is not available until identity is verified.",
      "The user can verify by typing: !verify <token>",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hard gate — blocks agent conversation until user is identified
// ---------------------------------------------------------------------------

/**
 * System prompt injected via prependContext when hard gate is active
 * and user is unregistered. Forces the agent to only discuss verification.
 */
export function formatHardGateSystemPrompt(channel: string, peerId: string): string {
  return [
    "[IDENTITY_GATE]",
    "status: LOCKED",
    `channel: ${channel}`,
    `channel_peer_id: ${peerId}`,
    "[/IDENTITY_GATE]",
    "",
    "IMPORTANT: This user has NOT been identified. You MUST NOT proceed with any request",
    "until they verify their identity. Guide them through these steps:",
    "",
    "1. Greet the user warmly and welcome them to Syntropy Journals",
    "2. Ask for their FIRST and LAST NAME as registered in the Syntropy Journals app",
    "3. Once they provide a name, tell them to type: !identify <first_name> <last_name>",
    "4. After identification, ask them to open Syntropy Journals → Settings → Pair Device",
    "5. Have them enter the 6-digit passcode here with: !verify <6-digit-code>",
    "",
    "IMPORTANT NOTES:",
    "- If the name doesn't match, remind them to use the EXACT name from their Syntropy Journals account",
    "- The 6-digit passcode expires in 10 minutes — tell them to generate a fresh one if needed",
    "- Do NOT answer any other questions until identity is verified",
    "- Be conversational and helpful about the verification process",
  ].join("\n");
}

/**
 * Short CTA appended to outgoing messages as a safety net
 * when the message_sending hook detects an unregistered user.
 */
export function formatHardGateReplyAppend(): string {
  // Surfaces the real identity flow (persist-user-identity registers
  // verify/identify/register). The gate exists to drive VERIFICATION, so the CTA
  // must name the verify path — omitting it was the long-standing copy gap that
  // left test/e2e/identity-memory-e2e.test.ts red since PR #9.
  //
  // ORDER MATTERS: identify THEN verify — they are sequential steps of ONE flow,
  // not alternatives (identify stores the match in pendingIdentify and its own
  // reply asks for the code). This mirrors formatHardGateSystemPrompt steps 3→5,
  // so the footer can't contradict the system prompt attached to the same turn.
  //
  // ARG SHAPE IS MODE-DEPENDENT: under the documented deployment mode
  // (auth.mode = "passcode-endpoint", see docs/deployment/headless-syntropy.md)
  // verifyToken() ONLY accepts a 4-10 digit code (jwt.ts regex) — an arbitrary
  // "app token" is rejected there. So the copy says 6-digit code and names where
  // it comes from. Do not reword this to "<token>" without checking the mode.
  //
  // Both `/` and `!` prefixes dispatch (src/plugins/commands.ts normalizes
  // `!` -> `/`), hence the trailing note.
  return (
    "\n\n---\nTo get started: `!identify <first_name> <last_name>` to find your " +
    "Syntropy Journals account, then `/verify <6-digit code>` from the app " +
    "(Settings → Pair Device). No app account yet? `/register <first_name> " +
    "<last_name>` sets up a chat-only profile. Both `/` and `!` work."
  );
}
