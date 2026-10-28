/**
 * Session keys carry the caller's identity (e.g. `agent:main:openresponses-user:<clerk sub>`),
 * so they must never appear verbatim in logs. The persisted rows keep the real key;
 * only the log line is redacted to a stable short hash.
 */
import { describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { sessionKeyForLog } from "./log-redaction.js";

vi.mock("./db.js", () => ({
  // A tagged-template stand-in: `sql\`SELECT 1\`` resolves, `sql.end()` closes.
  createPgClient: vi.fn(() => Object.assign(async () => [], { end: vi.fn(async () => undefined) })),
  ensureSchema: vi.fn(async () => undefined),
  persistMessage: vi.fn(async () => undefined),
  purgeExpiredConversations: vi.fn(async () => 0),
}));

const SUB = "user_3LLLckaxxSVjlkjs4qaxzHTvhc4";
const KEY = `agent:main:openresponses-user:${SUB.toLowerCase()}:h0fce366aa638b3e8`;

function api() {
  const hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];
  const info = vi.fn();
  const a = {
    id: "persist-postgres",
    name: "Persist (PostgreSQL)",
    source: "test",
    config: {},
    pluginConfig: { databaseUrl: "postgres://unused" },
    runtime: {},
    logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
    on: vi.fn((name: string, handler: (...a: unknown[]) => unknown) => {
      hooks.push({ name, handler });
    }),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
  } as unknown as OpenClawPluginApi;
  return { a, hooks, info };
}

describe("sessionKeyForLog", () => {
  test("never contains the key or the sub, and is stable per key", () => {
    const out = sessionKeyForLog(KEY);
    expect(out).toMatch(/^session#[0-9a-f]{12}$/);
    expect(out.toLowerCase()).not.toContain("user_");
    expect(out).toBe(sessionKeyForLog(KEY));
    expect(out).not.toBe(sessionKeyForLog(`${KEY}x`));
  });

  test("an absent key is logged as unknown", () => {
    expect(sessionKeyForLog(undefined)).toBe("session#unknown");
    expect(sessionKeyForLog("")).toBe("session#unknown");
  });
});

describe("persist-postgres hook logs", () => {
  test("the user- and assistant-message log lines carry no user_ id", async () => {
    const { default: plugin } = await import("./index.js");
    const { a, hooks, info } = api();
    plugin.register(a);
    const before = hooks.find((h) => h.name === "before_agent_start");
    const end = hooks.find((h) => h.name === "agent_end");
    expect(before && end).toBeTruthy();

    await before!.handler({ prompt: "hi" }, { sessionKey: KEY, messageProvider: "shrinemobile" });
    await end!.handler(
      { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], success: true },
      { sessionKey: KEY, messageProvider: "shrinemobile" },
    );

    const lines = info.mock.calls.map((c) => String(c[0]));
    const persisted = lines.filter((l) => l.includes("persisted"));
    expect(persisted.length).toBe(2);
    for (const l of persisted) {
      expect(l.toLowerCase()).not.toContain("user_");
      expect(l).not.toContain(KEY);
      expect(l).toContain(sessionKeyForLog(KEY));
    }
  });
});
