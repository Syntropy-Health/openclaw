# Identity Contract for Downstream Plugins

This document describes how other OpenClaw plugins and hooks should consume the user identity established by `persist-user-identity`.

## How Identity Is Exposed

The plugin injects a `[USER_IDENTITY]` block into the agent's `prependContext` via the `before_agent_start` hook at **priority 60**. This runs before most other plugins (persist-postgres runs at 50, memory plugins typically at default 0).

### Context Block Format

```
[USER_IDENTITY]
user_id: <uuid>
external_id: <string|none>
name: <first last|unknown>
channel: <telegram|whatsapp|slack|discord|chat|...>
verified: <true|false>
status: <verified|registered|unregistered|new_session>
[/USER_IDENTITY]
```

### Field Reference

| Field         | Type             | Description                                                                                                                      |
| ------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `user_id`     | UUID or `none`   | Canonical user ID (from `lp_users.id`). Stable across channels.                                                                  |
| `external_id` | string or `none` | Externally-issued ID from JWT `sub` claim or verify endpoint. Present only for verified users.                                   |
| `name`        | string           | User's display name. `unknown` if not yet registered.                                                                            |
| `channel`     | string           | The channel this message arrived from (e.g., `telegram`, `whatsapp`, `chat`).                                                    |
| `verified`    | boolean          | Whether user provided a valid external auth token.                                                                               |
| `status`      | enum             | `verified` = token-verified user, `registered` = name only, `unregistered` = unknown peer, `new_session` = returning known user. |

### Status Transitions

```
unregistered → !register → registered (channel-only)
unregistered → !verify   → verified   (token-linked)
registered   → !verify   → verified   (upgraded)
```

## How to Consume Identity in Your Plugin

### Retired: parsing this block (mono #542)

Plugins cannot read another plugin's `prependContext`: the `before_agent_start` event carries only
`{ prompt, messages }`. The old "parse from prependContext" pattern was never implemented by any
consumer (2026-10-18 census: 9 places checked, 0 readers), so it is retired. The block is model
context only. It deliberately carries **no `channel_peer_id`**: on SMS/WhatsApp that is the
subscriber's phone number, and the block reaches the LLM provider and the session transcript.
Use the database (below) or the shared scope key.

### Pattern 2: Direct DB Query (Recommended)

Share the same `DATABASE_URL` and query `lp_users` / `lp_user_channels` directly:

```typescript
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

// Look up user by channel identity
const rows = await sql`
  SELECT u.id, u.external_id, u.first_name, u.last_name
  FROM lp_users u
  JOIN lp_user_channels uc ON uc.user_id = u.id
  WHERE uc.channel = ${channel}
    AND uc.channel_peer_id = ${peerId}
`;
const userId = rows[0]?.external_id ?? rows[0]?.id;
```

### Pattern 3: Use as Memory Scoping Key

For memory plugins (Graphiti, LanceDB, pgvector), use the resolved identity as the partition/scope key:

```typescript
// Graphiti — use external_id as group_id
const group_id = identity.external_id ?? identity.id;
await graphiti.addEpisode({ group_id, content: message });
const results = await graphiti.search({ group_id, query });

// LanceDB — filter by user_id column
const results = await table.vectorSearch(vector).where(`user_id = '${identity.id}'`).limit(5);

// pgvector — WHERE clause
const rows = await sql`
  SELECT * FROM memories
  WHERE user_id = ${identity.id}
  ORDER BY embedding <=> ${sql.array(vector)}::vector
  LIMIT 5
`;
```

## Database Schema

The plugin creates these tables (shared `lp_` prefix with persist-postgres):

```sql
-- Canonical users (one row per real person)
lp_users (
  id UUID PRIMARY KEY,
  external_id VARCHAR(256) UNIQUE,  -- from JWT sub / verify endpoint
  first_name VARCHAR(128),
  last_name VARCHAR(128),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

-- Channel identity mappings (many channels → one user)
lp_user_channels (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES lp_users(id) ON DELETE CASCADE,
  channel VARCHAR(50),           -- "telegram", "whatsapp", "chat", ...
  channel_peer_id VARCHAR(512),  -- channel-specific identifier
  linked_at TIMESTAMPTZ,
  UNIQUE(channel, channel_peer_id)
)
```

### Joining with persist-postgres

To correlate messages with users:

```sql
SELECT u.id AS user_id, u.first_name, c.session_key, m.content
FROM lp_users u
JOIN lp_user_channels uc ON uc.user_id = u.id
JOIN lp_conversations c ON c.channel = uc.channel
  AND c.session_key LIKE '%' || uc.channel_peer_id || '%'
JOIN lp_messages m ON m.conversation_id = c.id
WHERE u.external_id = 'target-user-external-id'
ORDER BY m.created_at DESC;
```

## User Commands

| Command                    | Description                                       | Auth Required |
| -------------------------- | ------------------------------------------------- | ------------- |
| `!verify <token>`          | Validate JWT/token, link channel to verified user | No            |
| `!register <first> <last>` | Create channel-only identity (no token)           | No            |
| `/whoami`                  | Show current identity and this channel (masked)   | No            |

## Configuration

```yaml
plugins:
  persist-user-identity:
    databaseUrl: "postgresql://user:pass@host:5432/db" # or use DATABASE_URL env
    auth:
      mode: "jwt-hs256" # or "verify-endpoint"
      jwtSecret: "your-secret" # for jwt-hs256
      # verifyEndpoint: "https://myapp.com/api!verify"  # for verify-endpoint
      issuer: "https://myapp.com" # optional JWT claim checks
      audience: "openclaw-agent" # optional JWT claim checks
```

## Priority Ordering

When multiple plugins use `before_agent_start`, priority determines execution order (higher = first):

| Priority    | Plugin                    | What It Does                             |
| ----------- | ------------------------- | ---------------------------------------- |
| 60          | **persist-user-identity** | Resolves user, injects `[USER_IDENTITY]` |
| 50          | persist-postgres          | Persists user prompt to `lp_messages`    |
| 40          | (your memory plugin)      | Reads identity, scopes memory queries    |
| 0 (default) | memory-lancedb            | Auto-recall from vector store            |

This ensures identity is available before any downstream plugin needs it.
