import { openPluginPool } from "openclaw/plugin-sdk";
import postgres from "postgres";

/** Minimal logger the pool helper needs (the plugin api logger satisfies it). */
type PoolLogger = { warn: (message: string) => void };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserRow = {
  id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: Date;
  updated_at: Date;
};

export type UserChannelRow = {
  id: string;
  user_id: string;
  channel: string;
  channel_peer_id: string;
  linked_at: Date;
};

/** Joined result from user + channel lookup. */
export type ResolvedIdentity = UserRow & {
  channel: string;
  channel_peer_id: string;
  verified: boolean;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createPgClient(databaseUrl: string, logger: PoolLogger) {
  return openPluginPool(postgres, databaseUrl, { logger, plugin: "persist-user-identity" });
}

// ---------------------------------------------------------------------------
// Schema — idempotent, shares `lp_` prefix with persist-postgres
// ---------------------------------------------------------------------------

export async function ensureUserSchema(sql: postgres.Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS lp_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_id VARCHAR(256) UNIQUE,
      first_name VARCHAR(128),
      last_name VARCHAR(128),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS lp_user_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES lp_users(id) ON DELETE CASCADE,
      channel VARCHAR(50) NOT NULL,
      channel_peer_id VARCHAR(512) NOT NULL,
      linked_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(channel, channel_peer_id)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_uc_lookup
      ON lp_user_channels (channel, channel_peer_id)
  `;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Look up a user by their channel-specific peer identifier.
 * Returns the full user row plus channel info, or null if unlinked.
 */
export async function findUserByChannelPeer(
  sql: postgres.Sql,
  channel: string,
  channelPeerId: string,
): Promise<ResolvedIdentity | null> {
  const rows = await sql`
    SELECT u.*, uc.channel, uc.channel_peer_id,
           (u.external_id IS NOT NULL) AS verified
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${channelPeerId}
    LIMIT 1
  `;
  return (rows[0] as ResolvedIdentity | undefined) ?? null;
}

/**
 * Find user by their externally-issued identifier (e.g. JWT `sub` claim).
 */
export async function findUserByExternalId(
  sql: postgres.Sql,
  externalId: string,
): Promise<UserRow | null> {
  const rows = await sql`
    SELECT * FROM lp_users WHERE external_id = ${externalId} LIMIT 1
  `;
  return (rows[0] as UserRow | undefined) ?? null;
}

/**
 * Resolve the identity of a VERIFIED caller by external id (the server-verified
 * Clerk `sub` on ctx.externalId), shaped like {@link findUserByChannelPeer}'s
 * result for the turn's `channel`. Used instead of the (channel, peer) lookup on
 * verified turns: the session-derived peer is client-influenced and must never
 * select another user's row. `channel_peer_id` is empty — no consumer reads it
 * from the identity block (mono #542).
 */
export async function findIdentityByExternalId(
  sql: postgres.Sql,
  externalId: string,
  channel: string,
): Promise<ResolvedIdentity | null> {
  const user = await findUserByExternalId(sql, externalId);
  if (!user) {
    return null;
  }
  return { ...user, channel, channel_peer_id: "", verified: user.external_id !== null };
}

/**
 * Create a new user. `externalId` is null for channel-only (unverified) users.
 */
export async function createUser(
  sql: postgres.Sql,
  opts: { firstName?: string; lastName?: string; externalId?: string },
): Promise<UserRow> {
  const rows = await sql`
    INSERT INTO lp_users (first_name, last_name, external_id)
    VALUES (${opts.firstName ?? null}, ${opts.lastName ?? null}, ${opts.externalId ?? null})
    RETURNING *
  `;
  return rows[0] as UserRow;
}

/**
 * Link a channel identity to an existing user (upsert — reassigns if already linked).
 */
export async function linkChannelToUser(
  sql: postgres.Sql,
  userId: string,
  channel: string,
  channelPeerId: string,
): Promise<UserChannelRow> {
  const rows = await sql`
    INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
    VALUES (${userId}, ${channel}, ${channelPeerId})
    ON CONFLICT (channel, channel_peer_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      linked_at = now()
    RETURNING *
  `;
  return rows[0] as UserChannelRow;
}

/**
 * Set name on an existing user.
 */
export async function updateUserName(
  sql: postgres.Sql,
  userId: string,
  firstName: string,
  lastName: string,
): Promise<UserRow> {
  const rows = await sql`
    UPDATE lp_users
    SET first_name = ${firstName}, last_name = ${lastName}, updated_at = now()
    WHERE id = ${userId}
    RETURNING *
  `;
  return rows[0] as UserRow;
}

/**
 * Upgrade a channel-only user to a verified user by setting their external_id.
 * If a user with that external_id already exists, merges by re-linking the
 * channel identity to the existing verified user.
 */
export async function linkExternalId(
  sql: postgres.Sql,
  userId: string,
  externalId: string,
  channel: string,
  channelPeerId: string,
): Promise<UserRow> {
  const existing = await findUserByExternalId(sql, externalId);

  if (existing) {
    // Verified user already exists — re-link this channel to them
    await linkChannelToUser(sql, existing.id, channel, channelPeerId);
    return existing;
  }

  // Upgrade current user to verified
  const rows = await sql`
    UPDATE lp_users
    SET external_id = ${externalId}, updated_at = now()
    WHERE id = ${userId}
    RETURNING *
  `;
  return rows[0] as UserRow;
}

/**
 * G-lane [G1] auto-bind (A&D §7 [G1]): on a VERIFIED first-party turn, ensure the
 * `lp_users` row for the caller's Clerk identity and UPSERT the device link.
 *
 * - `externalId` is the SERVER-verified Clerk `sub` (never client-sent — the
 *   gateway only threads it after JWT verification). The user row is found by
 *   external_id or created carrying it; the channel leg NEVER writes
 *   external_id onto some other user (spine pin R1f — no forked writer).
 * - The link upsert is GUARDED: re-binding the caller's own device is idempotent
 *   and a fresh device binds, but a `(channel, channel_peer_id)` link owned by a
 *   DIFFERENT user is never reassigned — the device id is client-supplied, so an
 *   unguarded upsert let any verified caller take over a victim's binding by
 *   sending the victim's device id. Such a call throws
 *   {@link AutoBindRefusedError}; a genuine owner change goes through the owner's
 *   sign-out unbind ([G2]) first. `linkChannelToUser` (used by the commands) is
 *   unchanged.
 * Idempotent per turn; throws on DB failure or refusal (caller logs, never fails the turn).
 */
export async function autoBindVerifiedPeer(
  sql: postgres.Sql,
  params: { externalId: string; channel: string; channelPeerId: string },
): Promise<UserRow> {
  const existing = await findUserByExternalId(sql, params.externalId);
  let user = existing;
  if (!user) {
    try {
      user = await createUser(sql, { externalId: params.externalId });
    } catch (err) {
      // Concurrent first-turns race: external_id is UNIQUE, so a parallel turn
      // may have inserted between our find and create. Re-find; only rethrow if
      // the row truly isn't there (a genuine DB failure).
      user = await findUserByExternalId(sql, params.externalId);
      if (!user) {
        throw err;
      }
    }
  }
  // Atomic ownership guard: on conflict, update ONLY when the existing link is
  // already the caller's; otherwise the row is untouched and nothing returns.
  const linked = await sql`
    INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
    VALUES (${user.id}, ${params.channel}, ${params.channelPeerId})
    ON CONFLICT (channel, channel_peer_id) DO UPDATE SET
      linked_at = now()
    WHERE lp_user_channels.user_id = EXCLUDED.user_id
    RETURNING *
  `;
  if (linked.length === 0) {
    throw new AutoBindRefusedError();
  }
  return user;
}

/**
 * [G1] auto-bind refused: the `(channel, channel_peer_id)` link belongs to
 * another account. The message carries NO identifiers (safe to log as is).
 */
export class AutoBindRefusedError extends Error {
  readonly code = "device_bound_to_another_account";
  constructor() {
    super("auto-bind refused: device bound to another account");
    this.name = "AutoBindRefusedError";
  }
}

/**
 * G-lane [G2] unbind (A&D §7 must-fix #1): DELETE exactly one device LINK row —
 * NEVER `lp_users.external_id`. Ownership is enforced IN the SQL: the row is
 * deleted only when it belongs to the user whose verified external_id is given
 * (you can only unbind your own device; a mismatched or absent row is a no-op).
 * Blast radius = one `(channel, channel_peer_id)` link; the user's other
 * channels (WhatsApp pairing!) and other devices stay verified. Idempotent —
 * returns the number of rows deleted (0 or 1).
 */
export async function unlinkChannelPeerForUser(
  sql: postgres.Sql,
  params: { externalId: string; channel: string; channelPeerId: string },
): Promise<number> {
  const rows = await sql`
    DELETE FROM lp_user_channels uc
    USING lp_users u
    WHERE uc.user_id = u.id
      AND u.external_id = ${params.externalId}
      AND uc.channel = ${params.channel}
      AND uc.channel_peer_id = ${params.channelPeerId}
    RETURNING uc.id
  `;
  return rows.length;
}
