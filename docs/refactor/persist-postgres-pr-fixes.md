---
summary: "PRD: Address PR review feedback and CI failures for persist-postgres plugin and session timestamp features"
read_when:
  - Working on the persist-postgres extension plugin
  - Fixing CI failures related to session timestamps or PostgreSQL persistence
  - Addressing PR #15424 review feedback
title: "Persist-Postgres PR Fixes"
---

# PRD: Persist-Postgres Plugin and Session Timestamp PR Fixes

Upstream PR: [openclaw/openclaw#15424](https://github.com/openclaw/openclaw/pull/15424)
Fork PR: [Syntropy-Health/openclaw#1](https://github.com/Syntropy-Health/openclaw/pull/1)

## Context

PR #15424 adds `createdAt` tracking to `SessionEntry`, date-range filtering to the `sessions.list` gateway API, and introduces a new `persist-postgres` extension plugin for PostgreSQL persistence. The Greptile automated review flagged 5 functional issues (confidence 2/5, "not safe to merge"), and CI fails with 7 TypeScript compilation errors (6 in the new plugin code, 1 pre-existing upstream issue).

This PRD catalogs every issue and specifies the fix for each.

## Issue 1: Plugin config ignored

**Source:** [Greptile review comment](https://github.com/openclaw/openclaw/pull/15424#discussion_r2804016061)

**Problem:** `openclaw.plugin.json` declares a required `databaseUrl` config field with UI hints, but the plugin reads only `process.env.DATABASE_URL` and never consumes `api.pluginConfig`. Plugin configuration via the OpenClaw config UI or plugin config file is silently ignored.

**File:** `extensions/persist-postgres/src/index.ts`, lines 10-14

**Fix:** Read from `api.pluginConfig.databaseUrl` first, fall back to `process.env.DATABASE_URL`.

```ts
const databaseUrl =
  (api.pluginConfig?.databaseUrl as string | undefined) ??
  process.env.DATABASE_URL ??
  "";
```

**Acceptance criteria:**
- Plugin uses `api.pluginConfig.databaseUrl` when configured
- Falls back to `process.env.DATABASE_URL` if plugin config is not set
- Plugin disables itself with a warning when neither source provides a value

## Issue 2: Duplicate persistence paths

**Source:** [Greptile review comment](https://github.com/openclaw/openclaw/pull/15424#discussion_r2804016123)

**Problem:** The plugin persists the same logical user message via two overlapping hook paths:
- `before_agent_start` persists `event.prompt` as a user message
- `message_received` also persists inbound content as a user message

Similarly for assistant replies:
- `agent_end` extracts and persists the last assistant message
- `message_sent` also persists outbound content as an assistant message

A single inbound message triggers both `message_received` and `before_agent_start`, inserting duplicate rows in `lp_messages`.

**File:** `extensions/persist-postgres/src/index.ts`, lines 28-139

**Fix:** Choose one canonical persistence path per message direction. Use only agent lifecycle hooks (`before_agent_start` for user, `agent_end` for assistant) since they carry richer context (session key, full message history). Remove the `message_received` and `message_sent` hooks, or gate them so they only fire for channels where agent hooks do not run.

Recommended approach — remove the channel hooks entirely:

```ts
// Remove the message_received hook (lines 95-116)
// Remove the message_sent hook (lines 118-139)
```

If channel-only messages (no agent run) must also be persisted, deduplicate by checking whether the message was already inserted for the current session+timestamp window before inserting.

**Acceptance criteria:**
- A single inbound message is persisted exactly once in `lp_messages`
- A single assistant reply is persisted exactly once in `lp_messages`
- No duplicate rows for the same logical message

## Issue 3: Inflated message_count

**Source:** [Greptile review comment](https://github.com/openclaw/openclaw/pull/15424#discussion_r2804016197)

**Problem:** `upsertConversation()` unconditionally increments `message_count` on every `ON CONFLICT` upsert, even when no message is actually inserted (e.g., `agent_end` with no assistant message, or `before_agent_start` with empty prompt). Combined with the duplicate persistence paths (Issue 2), `message_count` drifts upward and becomes unreliable.

**File:** `extensions/persist-postgres/src/db.ts`, lines 87-90

**Fix:** Only call `upsertConversation()` when a message will actually be inserted, or decouple the count increment from the upsert. Preferred approach — increment `message_count` inside `insertMessage()` instead:

```sql
-- In insertMessage(), after inserting the message:
UPDATE lp_conversations
SET message_count = message_count + 1,
    last_message_at = now()
WHERE id = $1
```

And change the upsert's `ON CONFLICT` to only update `last_message_at` without touching `message_count`:

```sql
ON CONFLICT (session_key) DO UPDATE SET
  last_message_at = EXCLUDED.last_message_at
RETURNING *
```

**Acceptance criteria:**
- `message_count` increments only when a row is actually inserted into `lp_messages`
- `message_count` accurately reflects the number of messages in the conversation
- Existing tests updated to reflect correct count behavior

## Issue 4: `gen_random_uuid()` dependency

**Source:** [Greptile review comment](https://github.com/openclaw/openclaw/pull/15424#discussion_r2804016243)

**Problem:** Schema creation uses `gen_random_uuid()` for UUID primary key defaults. This function requires PostgreSQL 13+ (where it became a built-in) or the `pgcrypto` extension on older versions. On older Postgres instances without `pgcrypto`, `ensureSchema()` fails and the plugin cannot start.

**File:** `extensions/persist-postgres/src/db.ts`, lines 31-33

**Fix:** Generate UUIDs application-side using Node's `crypto.randomUUID()` and pass them as explicit values, removing the database-side UUID generation dependency. Alternatively, add a defensive `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` before the table creation (though this requires superuser privileges on some managed Postgres services).

Recommended approach — application-side UUIDs:

```ts
import crypto from "node:crypto";

// In upsertConversation:
const id = crypto.randomUUID();
// Pass id explicitly in INSERT

// In insertMessage:
const id = crypto.randomUUID();
// Pass id explicitly in INSERT
```

And change the schema to remove the `DEFAULT gen_random_uuid()`:

```sql
CREATE TABLE IF NOT EXISTS lp_conversations (
  id UUID PRIMARY KEY,
  ...
)
```

**Acceptance criteria:**
- Plugin starts successfully on PostgreSQL 12 and older without `pgcrypto`
- Plugin starts successfully on managed Postgres services (e.g., Neon, Supabase, RDS) regardless of extension availability
- UUID generation is handled application-side

## Issue 5: Integration test runs in CI without Postgres

**Source:** [Greptile review comment](https://github.com/openclaw/openclaw/pull/15424#discussion_r2804016303)

**Problem:** `extensions/persist-postgres/src/integration.test.ts` matches the default Vitest include patterns and will run during `pnpm test`. It creates a Postgres client with `DATABASE_URL` or a hardcoded localhost fallback. CI runners and developer machines without a local Postgres will fail or hang.

**File:** `extensions/persist-postgres/src/integration.test.ts`, lines 22-25

**Fix:** Gate the test behind an environment variable so it only runs when explicitly opted in. Use a `describe.skipIf()` or `beforeAll` early-exit pattern.

```ts
const SKIP_REASON = "DATABASE_URL not set; skipping integration tests";
const shouldRun = !!process.env.DATABASE_URL;

describe.skipIf(!shouldRun)("PostgreSQL conversation CRUD", () => {
  // ...
});
```

Remove the hardcoded localhost fallback to prevent accidental connections:

```ts
// Before (dangerous):
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/openclaw_e2e_test";

// After (safe):
const DATABASE_URL = process.env.DATABASE_URL ?? "";
```

**Acceptance criteria:**
- `pnpm test` passes without a running PostgreSQL instance
- Integration tests run when `DATABASE_URL` is explicitly set
- No hardcoded localhost connection strings

## Issue 6: TypeScript errors in `db.ts`

**Source:** CI `check` job failure

**Errors:**
1. `db.ts(113,34): error TS2345` — `Record<string, unknown>` is not assignable to `JSONValue` when passing metadata to `sql.json()`
2. `db.ts(163,28): error TS2345` — `unknown[]` is not assignable to `ParameterOrJSON<never>[]` in `sql.unsafe(query, values)`

**Fix for error 1:** Cast metadata to the expected type:

```ts
${opts.metadata ? sql.json(opts.metadata as Record<string, string | number | boolean | null>) : sql.json({})}
```

Or use a type assertion:

```ts
sql.json(opts.metadata as postgres.JSONValue)
```

**Fix for error 2:** Type the `values` array correctly:

```ts
const values: postgres.ParameterOrJSON<never>[] = [];
```

Or cast at the call site:

```ts
return sql.unsafe(query, values as postgres.ParameterOrJSON<never>[]) as Promise<PgSessionRow[]>;
```

**Acceptance criteria:**
- `pnpm tsgo` passes with no errors in `extensions/persist-postgres/src/db.ts`

## Issue 7: TypeScript errors in `index.ts`

**Source:** CI `check` job failure

**Errors:**
1. `index.ts(72,19): error TS2769` — No overload matches the `.find()` call on `event.messages` (typed as `unknown[]`)
2. `index.ts(75,36): error TS2339` — Property `content` does not exist on type `{}`
3. `index.ts(76,33): error TS2339` — Property `content` does not exist on type `{}`
4. `index.ts(77,48): error TS2339` — Property `content` does not exist on type `{}`

**Problem:** `event.messages` is typed as `unknown[]` in the plugin SDK. The code assumes it's an array of objects with `role` and `content` properties without proper type narrowing.

**Fix:** Add explicit type narrowing:

```ts
type AgentMessage = { role?: string; content?: string | unknown };

const messages: AgentMessage[] = Array.isArray(event.messages)
  ? (event.messages as AgentMessage[])
  : [];
const lastAssistant = [...messages]
  .reverse()
  .find((m) => m.role === "assistant");
if (lastAssistant?.content !== undefined) {
  const content =
    typeof lastAssistant.content === "string"
      ? lastAssistant.content
      : JSON.stringify(lastAssistant.content);
  // ...
}
```

**Acceptance criteria:**
- `pnpm tsgo` passes with no errors in `extensions/persist-postgres/src/index.ts`
- Type safety is maintained without using `any`

## Issue 8: Pre-existing upstream TypeScript error (informational)

**Source:** CI `check` job failure

**Error:** `src/commands/auth-choice-options.ts(37,5): error TS2322: Type '"vllm"' is not assignable to type 'AuthChoiceGroupId'`

**Status:** This is a pre-existing error in the upstream `openclaw/openclaw` main branch, not introduced by this PR. No action required in this PR, but it causes the CI `check` job to fail regardless of our changes.

**Recommendation:** File a separate issue or note this as a known upstream issue. The PR should not attempt to fix unrelated upstream code.

## Implementation priority

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | Issue 6: TS errors in db.ts | Small | Blocks CI |
| P0 | Issue 7: TS errors in index.ts | Small | Blocks CI |
| P0 | Issue 5: Integration test in CI | Small | Blocks CI |
| P1 | Issue 2: Duplicate persistence | Medium | Data correctness |
| P1 | Issue 3: Inflated message_count | Small | Data correctness |
| P1 | Issue 1: Plugin config ignored | Small | Usability |
| P2 | Issue 4: gen_random_uuid | Small | Compatibility |
| P3 | Issue 8: Upstream TS error | N/A | Not our scope |

## Testing plan

- All P0 fixes must pass `pnpm check` (format + typecheck + lint)
- All P0 fixes must pass `pnpm test` without a running PostgreSQL
- P1/P2 fixes should include updated unit tests in `integration.test.ts`
- End-to-end validation: gateway start, chat via `/hooks/chat`, verify single message row per logical message in `lp_conversations` + `lp_messages`
