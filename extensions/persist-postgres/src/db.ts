import postgres from "postgres";

export type PgSessionRow = {
  id: string;
  session_key: string;
  channel: string;
  started_at: Date;
  last_message_at: Date;
  message_count: number;
};

export type PgMessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: Date;
  metadata: Record<string, unknown>;
};

export function createPgClient(databaseUrl: string) {
  return postgres(databaseUrl, { max: 10 });
}

/**
 * Ensure the lp_conversations and lp_messages tables exist.
 * Safe to call repeatedly (uses IF NOT EXISTS).
 */
export async function ensureSchema(sql: postgres.Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS lp_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel VARCHAR(50) NOT NULL,
      session_key VARCHAR(512) NOT NULL UNIQUE,
      started_at TIMESTAMPTZ DEFAULT now(),
      last_message_at TIMESTAMPTZ DEFAULT now(),
      message_count INTEGER DEFAULT 0
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_conv_session ON lp_conversations (session_key)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_conv_last_msg ON lp_conversations (last_message_at DESC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS lp_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID REFERENCES lp_conversations(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      metadata JSONB DEFAULT '{}'
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_msg_conv ON lp_messages (conversation_id, created_at)
  `;
}

/**
 * Upsert a conversation (session) into PostgreSQL.
 * Maps OpenClaw session keys to lp_conversations rows.
 */
export async function upsertConversation(
  sql: postgres.Sql,
  opts: {
    sessionKey: string;
    channel: string;
    startedAt?: Date;
    lastMessageAt?: Date;
  },
) {
  const now = new Date();
  const rows = await sql`
    INSERT INTO lp_conversations (session_key, channel, started_at, last_message_at)
    VALUES (
      ${opts.sessionKey},
      ${opts.channel},
      ${opts.startedAt ?? now},
      ${opts.lastMessageAt ?? now}
    )
    ON CONFLICT (session_key) DO UPDATE SET
      last_message_at = EXCLUDED.last_message_at,
      message_count = lp_conversations.message_count + 1
    RETURNING *
  `;
  return rows[0] as PgSessionRow;
}

/**
 * Insert a message into PostgreSQL.
 */
export async function insertMessage(
  sql: postgres.Sql,
  opts: {
    conversationId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  },
) {
  const rows = await sql`
    INSERT INTO lp_messages (conversation_id, role, content, metadata)
    VALUES (
      ${opts.conversationId},
      ${opts.role},
      ${opts.content},
      ${opts.metadata ? sql.json(opts.metadata) : sql.json({})}
    )
    RETURNING *
  `;
  return rows[0] as PgMessageRow;
}

/**
 * Query conversations with optional date-range filters.
 * Mirrors the createdAfter/createdBefore/updatedAfter/updatedBefore
 * params from the sessions.list API.
 */
export async function queryConversations(
  sql: postgres.Sql,
  opts: {
    createdAfter?: number;
    createdBefore?: number;
    updatedAfter?: number;
    updatedBefore?: number;
    limit?: number;
  } = {},
) {
  const values: unknown[] = [];

  let query = `SELECT * FROM lp_conversations WHERE 1=1`;

  if (opts.createdAfter !== undefined) {
    query += ` AND started_at >= $${values.length + 1}::timestamptz`;
    values.push(new Date(opts.createdAfter).toISOString());
  }
  if (opts.createdBefore !== undefined) {
    query += ` AND started_at <= $${values.length + 1}::timestamptz`;
    values.push(new Date(opts.createdBefore).toISOString());
  }
  if (opts.updatedAfter !== undefined) {
    query += ` AND last_message_at >= $${values.length + 1}::timestamptz`;
    values.push(new Date(opts.updatedAfter).toISOString());
  }
  if (opts.updatedBefore !== undefined) {
    query += ` AND last_message_at <= $${values.length + 1}::timestamptz`;
    values.push(new Date(opts.updatedBefore).toISOString());
  }

  query += ` ORDER BY last_message_at DESC`;

  if (opts.limit !== undefined) {
    query += ` LIMIT $${values.length + 1}`;
    values.push(opts.limit);
  }

  return sql.unsafe(query, values) as Promise<PgSessionRow[]>;
}

/**
 * Map a PostgreSQL conversation row to an OpenClaw SessionEntry-compatible object.
 */
export function pgRowToSessionEntry(row: PgSessionRow) {
  return {
    sessionId: row.id,
    createdAt: new Date(row.started_at).getTime(),
    updatedAt: new Date(row.last_message_at).getTime(),
    channel: row.channel,
    displayName: `${row.channel}:${row.session_key}`,
  };
}
