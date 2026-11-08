import postgres from "postgres";
/**
 * Integration tests for persist-postgres plugin.
 *
 * Requires a running PostgreSQL instance. Uses DATABASE_URL env var
 * or falls back to a local default.
 *
 * Run with: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openclaw_e2e_test bun test extensions/persist-postgres/src/integration.e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { ensureSchema, upsertConversation, insertMessage, persistMessage } from "./db.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/openclaw_e2e_test";

const sql = postgres(DATABASE_URL, { max: 5 });

const testPrefix = `test_lp_${Date.now()}`;

const hour = 3_600_000;
const baseTime = new Date("2024-06-15T12:00:00Z").getTime();

let convOldId: string;
let convMidId: string;
let convNewId: string;

beforeAll(async () => {
  await ensureSchema(sql);

  // Seed three conversations with distinct timestamps
  const [convOld] = await sql`
    INSERT INTO lp_conversations (channel, session_key, started_at, last_message_at, message_count)
    VALUES (
      'whatsapp', ${`${testPrefix}:old-session`},
      ${new Date(baseTime - 24 * hour).toISOString()}::timestamptz,
      ${new Date(baseTime - 12 * hour).toISOString()}::timestamptz,
      3
    )
    RETURNING id
  `;
  convOldId = convOld.id;

  const [convMid] = await sql`
    INSERT INTO lp_conversations (channel, session_key, started_at, last_message_at, message_count)
    VALUES (
      'telegram', ${`${testPrefix}:mid-session`},
      ${new Date(baseTime - 6 * hour).toISOString()}::timestamptz,
      ${new Date(baseTime - 3 * hour).toISOString()}::timestamptz,
      5
    )
    RETURNING id
  `;
  convMidId = convMid.id;

  const [convNew] = await sql`
    INSERT INTO lp_conversations (channel, session_key, started_at, last_message_at, message_count)
    VALUES (
      'web', ${`${testPrefix}:new-session`},
      ${new Date(baseTime - 1 * hour).toISOString()}::timestamptz,
      ${new Date(baseTime).toISOString()}::timestamptz,
      1
    )
    RETURNING id
  `;
  convNewId = convNew.id;

  // Seed messages for each conversation
  await insertMessage(sql, {
    conversationId: convOldId,
    role: "user",
    content: "Hello from old session",
    metadata: { source: "integration-test" },
  });
  await insertMessage(sql, {
    conversationId: convOldId,
    role: "assistant",
    content: "Response in old session",
  });

  await insertMessage(sql, {
    conversationId: convMidId,
    role: "user",
    content: "Hello from mid session",
  });

  await insertMessage(sql, {
    conversationId: convNewId,
    role: "user",
    content: "Hello from new session",
  });
});

afterAll(async () => {
  // Clean up test data
  await sql`DELETE FROM lp_messages WHERE conversation_id IN (
    SELECT id FROM lp_conversations WHERE session_key LIKE ${testPrefix + "%"}
  )`;
  await sql`DELETE FROM lp_conversations WHERE session_key LIKE ${testPrefix + "%"}`;
  await sql.end();
});

// ── PostgreSQL CRUD Tests ────────────────────────────────────────────

describe("PostgreSQL conversation CRUD", () => {
  test("seeded conversations are queryable", async () => {
    const rows = await sql`
      SELECT * FROM lp_conversations
      WHERE session_key LIKE ${testPrefix + "%"}
      ORDER BY started_at ASC
    `;
    expect(rows.length).toBe(3);
    expect(rows[0].channel).toBe("whatsapp");
    expect(rows[1].channel).toBe("telegram");
    expect(rows[2].channel).toBe("web");
  });

  test("messages are linked to conversations", async () => {
    const rows = await sql`
      SELECT m.role, m.content, c.session_key
      FROM lp_messages m
      JOIN lp_conversations c ON c.id = m.conversation_id
      WHERE c.session_key LIKE ${testPrefix + "%"}
      ORDER BY m.created_at ASC
    `;
    expect(rows.length).toBe(4);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("Hello from old session");
  });

  test("upsertConversation updates last_message_at on conflict", async () => {
    const before = await sql`
      SELECT last_message_at FROM lp_conversations WHERE id = ${convOldId}
    `;
    const beforeTs = new Date(before[0].last_message_at).getTime();

    const newTime = new Date(baseTime + 1 * hour);
    await upsertConversation(sql, {
      sessionKey: `${testPrefix}:old-session`,
      channel: "whatsapp",
      lastMessageAt: newTime,
    });

    const after = await sql`
      SELECT last_message_at, message_count FROM lp_conversations WHERE id = ${convOldId}
    `;
    const afterTs = new Date(after[0].last_message_at).getTime();
    expect(afterTs).toBeGreaterThan(beforeTs);
    // message_count stays at 5 (seeded 3 + 2 insertMessage calls in beforeAll);
    // upsert no longer increments count
    expect(after[0].message_count).toBe(5);

    // Restore original timestamp for subsequent tests
    await sql`
      UPDATE lp_conversations
      SET last_message_at = ${new Date(baseTime - 12 * hour).toISOString()}::timestamptz
      WHERE id = ${convOldId}
    `;
  });
});

// ── PostgreSQL Date-Range Query Tests ────────────────────────────────

describe("persistMessage (combined upsert + insert CTE)", () => {
  test("brand-new conversation: creates conv, inserts message, count = 1", async () => {
    const key = `${testPrefix}:pm-new`;
    const msg = await persistMessage(sql, {
      sessionKey: key,
      channel: "gateway",
      role: "user",
      content: "first message",
      metadata: { src: "pm-test" },
    });

    // returns the inserted message row
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("first message");

    const [conv] = await sql`
      SELECT message_count FROM lp_conversations WHERE session_key = ${key}
    `;
    // THE TRAP: must be 1, not 0
    expect(conv.message_count).toBe(1);

    const msgs = await sql`
      SELECT * FROM lp_messages WHERE conversation_id = ${msg.conversation_id}
    `;
    expect(msgs.length).toBe(1);
    expect(msgs[0].metadata).toEqual({ src: "pm-test" });
  });

  test("existing conversation: bumps count by 1 and touches last_message_at", async () => {
    const key = `${testPrefix}:pm-existing`;
    await persistMessage(sql, { sessionKey: key, channel: "gateway", role: "user", content: "m1" });

    const newTs = new Date(baseTime + 5 * hour);
    await persistMessage(sql, {
      sessionKey: key,
      channel: "gateway",
      role: "assistant",
      content: "m2",
      lastMessageAt: newTs,
    });

    const [conv] = await sql`
      SELECT message_count, last_message_at FROM lp_conversations WHERE session_key = ${key}
    `;
    expect(conv.message_count).toBe(2);
    expect(new Date(conv.last_message_at).getTime()).toBe(newTs.getTime());

    const msgs = await sql`
      SELECT role FROM lp_messages WHERE conversation_id = (
        SELECT id FROM lp_conversations WHERE session_key = ${key}
      ) ORDER BY created_at
    `;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("equivalent to upsertConversation + insertMessage on the same key", async () => {
    // two-call path (the old hook behavior)
    const keyOld = `${testPrefix}:pm-equiv-old`;
    const convA = await upsertConversation(sql, { sessionKey: keyOld, channel: "gateway" });
    await insertMessage(sql, { conversationId: convA.id, role: "user", content: "x" });

    // combined path
    const keyNew = `${testPrefix}:pm-equiv-new`;
    await persistMessage(sql, {
      sessionKey: keyNew,
      channel: "gateway",
      role: "user",
      content: "x",
    });

    const [a] = await sql`SELECT message_count FROM lp_conversations WHERE session_key = ${keyOld}`;
    const [b] = await sql`SELECT message_count FROM lp_conversations WHERE session_key = ${keyNew}`;
    expect(b.message_count).toBe(a.message_count); // both 1
  });
});
