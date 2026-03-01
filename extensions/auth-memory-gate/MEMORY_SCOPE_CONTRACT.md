# Memory Scope Contract for Downstream Plugins

This document describes how memory plugins (Graphiti, LanceDB, pgvector, etc.) should consume the memory scope established by `auth-memory-gate`.

## How Memory Scope Is Exposed

The plugin injects a `[MEMORY_SCOPE]` block into the agent's `prependContext` via the `before_agent_start` hook at **priority 40**. This runs after identity resolution (60) and message persistence (50), but before memory plugins (default 0).

### Context Block Format

```
[MEMORY_SCOPE]
scope_key: <external_id or user_id>
user_id: <uuid>
external_id: <string|none>
verified: <true|false>
gated: <true|false>
[/MEMORY_SCOPE]
```

When memory is gated (unverified user + `requireVerified: true`):

```
[MEMORY_SCOPE]
gated: true
[/MEMORY_SCOPE]

Memory retrieval is not available until identity is verified.
The user can verify by typing: /verify <token>
```

### Field Reference

| Field         | Type           | Description                                                                               |
| ------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `scope_key`   | string         | The primary key for memory scoping. Use this as Graphiti `group_id`, LanceDB filter, etc. |
| `user_id`     | UUID           | Internal canonical user ID (from `lp_users.id`). Stable across channels.                  |
| `external_id` | string or none | Externally-issued ID from JWT `sub` claim. Present only for verified users.               |
| `verified`    | boolean        | Whether user provided a valid external auth token.                                        |
| `gated`       | boolean        | Whether memory retrieval is blocked. When `true`, all other fields are absent.            |

### Scope Key Selection

The `scope_key` is derived as follows:

1. If the user has an `external_id` (verified via `/verify <token>`), the scope key is the `external_id`. This provides cross-channel memory continuity — the same user on Telegram, WhatsApp, and web chat shares one memory namespace.
2. If the user is channel-only (registered via `/register` without token), the scope key is the internal `user_id` UUID. This provides per-channel isolation without cross-channel linking.

## How to Consume Scope in Your Plugin

### Pattern 1: Parse from prependContext

In your `before_agent_start` hook (at default priority 0), parse the `[MEMORY_SCOPE]` block:

```typescript
api.on("before_agent_start", async (event) => {
  // Check if scope is present and not gated
  const scopeMatch = event.prompt?.match?.(/\[MEMORY_SCOPE\][\s\S]*?scope_key: (.+)/);
  const gatedMatch = event.prompt?.match?.(/\[MEMORY_SCOPE\][\s\S]*?gated: true/);

  if (gatedMatch || !scopeMatch) {
    // No scope available or gated — skip memory retrieval
    return;
  }

  const scopeKey = scopeMatch[1].trim();
  // Use scopeKey for scoped memory retrieval...
});
```

> **Note**: Parsing prependContext works because all prior hooks' `prependContext` values are prepended to the `event.prompt` before your hook runs. However, the `event.prompt` in `before_agent_start` is the raw user message — not the accumulated prompt. Use the direct DB query pattern (Pattern 2) for more reliable scope access.

### Pattern 2: Direct DB Query (Recommended)

Share the same `DATABASE_URL` and query `lp_users` / `lp_user_channels` directly:

```typescript
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

// Look up user by channel identity
const rows = await sql`
  SELECT u.id, u.external_id
  FROM lp_users u
  JOIN lp_user_channels uc ON uc.user_id = u.id
  WHERE uc.channel = ${channel}
    AND uc.channel_peer_id = ${peerId}
`;
const scopeKey = rows[0]?.external_id ?? rows[0]?.id;
```

### Pattern 3: Backend-Specific Scoping

#### Graphiti (Python HTTP service)

Use `scope_key` as the `group_id` parameter:

```typescript
// Write: scope episode to user's graph namespace
await graphitiClient.addEpisode({
  group_id: scopeKey,
  content: message,
});

// Read: search only within user's namespace
const results = await graphitiClient.search({
  group_ids: [scopeKey],
  query: userMessage,
});
```

#### LanceDB (Vector search with filter)

Use `scope_key` in `.where()` predicate:

```typescript
// Search with user filter
const results = await table.vectorSearch(vector).where(`userId = '${scopeKey}'`).limit(5).toArray();

// Store with user tag
await table.add([{ text, vector, userId: scopeKey, category, createdAt: Date.now() }]);
```

> **Note**: This requires adding a `userId` column to the LanceDB table. See "LanceDB Migration" below.

#### pgvector (SQL WHERE clause)

Use `scope_key` in parameterized queries:

```typescript
const rows = await sql`
  SELECT content, 1 - (embedding <=> ${vectorLiteral}::vector) AS score
  FROM memories
  WHERE user_id = ${scopeKey}
  ORDER BY embedding <=> ${vectorLiteral}::vector
  LIMIT 5
`;
```

## Gating Behavior

When the `[MEMORY_SCOPE]` block contains `gated: true`:

- **Memory plugins should skip recall entirely.** Do not inject any memories into context.
- The gate message tells the user how to verify their identity.
- Once verified (via `/verify <token>`), subsequent messages will have `gated: false` and memory recall proceeds normally.

## Database Schema

This plugin reads from the tables created by `persist-user-identity`:

```sql
lp_users (
  id UUID PRIMARY KEY,
  external_id VARCHAR(256) UNIQUE,
  first_name VARCHAR(128),
  last_name VARCHAR(128),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

lp_user_channels (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES lp_users(id) ON DELETE CASCADE,
  channel VARCHAR(50),
  channel_peer_id VARCHAR(512),
  linked_at TIMESTAMPTZ,
  UNIQUE(channel, channel_peer_id)
)
```

## Priority Ordering

| Priority    | Plugin                    | What It Does                             |
| ----------- | ------------------------- | ---------------------------------------- |
| 60          | persist-user-identity     | Resolves user, injects `[USER_IDENTITY]` |
| 50          | persist-postgres          | Persists user prompt to `lp_messages`    |
| 40          | **auth-memory-gate**      | Resolves scope, injects `[MEMORY_SCOPE]` |
| 0 (default) | memory-lancedb / graphiti | Auto-recall from vector/graph store      |

## Configuration

```yaml
plugins:
  auth-memory-gate:
    databaseUrl: "postgresql://user:pass@host:5432/db" # or use DATABASE_URL env
    requireVerified: false # set true to gate memory behind verified identity
    gateMessage: "" # optional custom message for gated users
```

## LanceDB Migration (Future)

To add user scoping to an existing memory-lancedb deployment:

1. Add a `userId` column to the LanceDB table:

   ```typescript
   await table.addColumns([{ name: "userId", valueSql: "cast(null as varchar)" }]);
   ```

2. Create a scalar index for filter performance:

   ```typescript
   await table.createIndex("userId");
   ```

3. Modify `memory-lancedb` to:
   - Read `scope_key` from the DB (Pattern 2) in `before_agent_start`
   - Add `.where(\`userId = '${scopeKey}'\`)` to vector search
   - Tag new memories with `userId: scopeKey` in `agent_end`
