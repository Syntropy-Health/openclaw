/**
 * The plugin's Postgres WIRING (index.ts), with a recording `postgres` double:
 * the store factories are tested against a real database elsewhere, but how
 * register() connects them was not. Two properties matter:
 *
 *  1. Every store's first query runs AFTER the lp_memory_* schema is created
 *     (each store method awaits the shared, lazy schema step).
 *  2. Tombstones are looked up and written as KEYED values,
 *     tombstoneKey(entryHash, pepper), never the raw entry hashes. A raw-hash
 *     lookup would never match a stored key, so a forgotten entry would be
 *     re-ingested.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Query = { text: string; values: unknown[] };
const db = vi.hoisted(() => ({
  log: [] as Query[],
  peers: new Map<string, string | null>(),
  /** Stored tombstones, keyed `${group_id}\u0000${entry_hash}` as the table's primary key is. */
  tombstones: new Set<string>(),
  /** The one lp_users row the operator forget can find. */
  userId: "7",
  userExternalId: "",
}));

vi.mock("postgres", () => {
  const sql = Object.assign(
    (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      db.log.push({ text, values });
      if (text.includes("lp_user_channels")) {
        const peer = values[1] as string;
        return Promise.resolve(db.peers.has(peer) ? [{ external_id: db.peers.get(peer) }] : []);
      }
      if (/FROM\s+lp_users\s+WHERE\s+id\s*=/i.test(text)) {
        return Promise.resolve(
          values[0] === db.userId ? [{ id: db.userId, external_id: db.userExternalId }] : [],
        );
      }
      // receipts.ts: WHERE group_id = $1 AND entry_hash = ANY($2) / SELECT $1, h FROM unnest($2).
      if (/SELECT\s+entry_hash\s+FROM\s+lp_memory_tombstones/i.test(text)) {
        const [group, hashes] = values as [string, string[]];
        return Promise.resolve(
          hashes
            .filter((h) => db.tombstones.has(`${group}\u0000${h}`))
            .map((entry_hash) => ({ entry_hash })),
        );
      }
      if (/INSERT\s+INTO\s+lp_memory_tombstones/i.test(text)) {
        const [group, hashes] = values as [string, string[]];
        for (const h of hashes) {
          db.tombstones.add(`${group}\u0000${h}`);
        }
      }
      return Promise.resolve([]);
    },
    { end: () => Promise.resolve() },
  );
  return { default: () => sql };
});

import { entryHash, opaqueGroupId, tombstoneKey } from "./receipts.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const APPROVAL = {
  ruling: "use Zep now, zep is accepted as BAA. productionize GCP Graphiti in parallel",
  approvalsRow: 42,
  date: "2026-10-26",
};
const CLERK = "user_2abcDEF345ghiJKL678mnoPQR";
const PEPPER = "b".repeat(64);
const VERIFIED = {
  messageProvider: "shrinemobile",
  sessionKey: "agent:main:openresponses-user:u1",
  externalId: CLERK,
};
const TURN = {
  success: true,
  messages: [
    {
      role: "user",
      content: `[USER_IDENTITY]\nexternal_id: ${CLERK}\n[/USER_IDENTITY]\n\nI slept badly`,
    },
    { role: "assistant", content: "Sorry to hear that." },
  ],
};
/** The two entries TURN minimises to (phi-approval.test.ts pins this shape). */
const ITEMS = [
  { role: "user" as const, text: "I slept badly" },
  { role: "assistant" as const, text: "Sorry to hear that." },
];
const flush = () => new Promise((r) => setTimeout(r, 0));

type Hook = (event: unknown, ctx: unknown) => unknown;
type Route = { path: string; handler: (req: unknown, res: unknown) => Promise<void> };
type CliSetup = (ctx: { program: Command }) => void;
type Service = { start: () => void; stop?: () => Promise<void> };

async function register() {
  const hooks: Record<string, Hook> = {};
  const routes: Route[] = [];
  let cli: CliSetup | null = null;
  let service: Service | null = null;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const noop = vi.fn();
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: { channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+15551234567"] } } },
    pluginConfig: {
      backend: "zep-cloud",
      apiKey: "z_key",
      groupIdStrategy: "identity",
      databaseUrl: "postgres://mock/db",
      phiCloudApproval: APPROVAL,
    },
    runtime: {},
    logger,
    registerTool: noop,
    registerHook: noop,
    registerHttpHandler: noop,
    registerHttpRoute: vi.fn((r: Route) => routes.push(r)),
    registerChannel: noop,
    registerGatewayMethod: noop,
    registerCli: vi.fn((setup: CliSetup) => {
      cli = setup;
    }),
    registerService: vi.fn((svc: Service) => {
      service = svc;
    }),
    registerProvider: noop,
    registerCommand: noop,
    resolvePath: (p: string) => p,
    on: (name: string, h: Hook) => {
      hooks[name] = h;
    },
  };
  const mod = await import("./index.js");
  await mod.default.register(api as never);
  /** Run `graphiti <args>` through the plugin's own CLI wiring. */
  const runCli = async (...args: string[]) => {
    const program = new Command().exitOverride();
    cli!({ program });
    await program.parseAsync(["node", "openclaw", "graphiti", ...args]);
  };
  return { hooks, logger, runCli, service: () => service! };
}

const isDdl = (q: Query) => /^\s*(CREATE|ALTER|DO\b)/i.test(q.text.trimStart());
/** Index of the LAST schema statement: the schema step has FINISHED only after it. */
const lastDdl = () => db.log.map(isDdl).lastIndexOf(true);
/** Index of the first query a store METHOD issues on these tables (not the schema's own repair). */
const firstMethodQuery = (tables: RegExp) =>
  db.log.findIndex((q) => /^\s*(SELECT|INSERT|DELETE|WITH)\b/i.test(q.text) && tables.test(q.text));
const OPAQUE = () => opaqueGroupId(CLERK, PEPPER);

beforeEach(() => {
  db.log.length = 0;
  db.peers.clear();
  db.tombstones.clear();
  db.peers.set("u1", CLERK);
  db.userExternalId = CLERK;
  process.env.OPENCLAW_MEMORY_GROUP_KEY = PEPPER;
  vi.spyOn(ZepCloudClient.prototype, "confirm").mockResolvedValue({
    status: "confirmed",
    episodeIds: ["ep-1"],
  });
});

afterEach(() => {
  delete process.env.OPENCLAW_MEMORY_GROUP_KEY;
  vi.restoreAllMocks();
});

describe("Postgres wiring (index.ts)", () => {
  it("the ledger's first query runs after the lp_memory_* schema is created", async () => {
    const submit = vi.spyOn(ZepCloudClient.prototype, "submit").mockResolvedValue({ ref: "ep-1" });
    const { hooks } = await register();
    db.log.length = 0; // count from the first turn: registration itself may not touch the DB
    await hooks.agent_end?.(TURN, VERIFIED);
    await flush();
    expect(submit).toHaveBeenCalledOnce();
    const ddl = lastDdl();
    const first = firstMethodQuery(/lp_memory_(receipts|tombstones|pending)/i);
    expect(ddl).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(ddl);
  });

  it("the recall store's first query runs after the lp_memory_* schema is created", async () => {
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue([]);
    vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const { hooks } = await register();
    db.log.length = 0;
    // A turn with a run id: recall writes its record (none found) for the panel.
    await hooks.before_agent_start?.(
      { prompt: "how did I sleep?" },
      { ...VERIFIED, runId: "run-1" },
    );
    await flush();
    const ddl = lastDdl();
    const first = firstMethodQuery(/lp_memory_recall/i);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(ddl).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(ddl);
  });

  it("the highlight store's first query runs after the lp_memory_* schema is created", async () => {
    vi.useFakeTimers();
    try {
      const { service } = await register();
      db.log.length = 0;
      // The worker's first pass asks the highlight store which groups are due, before
      // anything else touches the database in this registration.
      service().start();
      await vi.advanceTimersByTimeAsync(60_000);
      const ddl = lastDdl();
      const first = firstMethodQuery(/lp_memory_highlights/i);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(ddl).toBeGreaterThanOrEqual(0);
      expect(first).toBeGreaterThan(ddl);
      await service().stop?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tombstones are looked up as tombstoneKey(entryHash, pepper), never the raw hash", async () => {
    vi.spyOn(ZepCloudClient.prototype, "submit").mockResolvedValue({ ref: "ep-1" });
    const { hooks } = await register();
    await hooks.agent_end?.(TURN, VERIFIED);
    await flush();
    const lookups = db.log.filter((q) =>
      /SELECT\s+entry_hash\s+FROM\s+lp_memory_tombstones/i.test(q.text),
    );
    expect(lookups.length).toBeGreaterThan(0);
    for (const q of lookups) {
      expect(q.values[0]).toBe(OPAQUE());
    }
    const asked = lookups.flatMap((q) => q.values[1] as string[]);
    const raw = ITEMS.map(entryHash);
    const keyed = raw.map((h) => tombstoneKey(h, PEPPER));
    expect(asked).toEqual(expect.arrayContaining(keyed));
    for (const h of raw) {
      expect(asked).not.toContain(h);
    }
  });

  it("RED arm: an entry tombstoned under its KEY is not sent again", async () => {
    const submit = vi.spyOn(ZepCloudClient.prototype, "submit").mockResolvedValue({ ref: "ep-1" });
    // A forget stored both entries' keys; only the keyed lookup can find them.
    for (const item of ITEMS) {
      db.tombstones.add(`${OPAQUE()}\u0000${tombstoneKey(entryHash(item), PEPPER)}`);
    }
    const { hooks } = await register();
    await hooks.agent_end?.(TURN, VERIFIED);
    await flush();
    expect(submit).not.toHaveBeenCalled();
    // Control: the same turn with no tombstones IS sent, so "not sent" above is the
    // tombstone at work, not a turn that would never have been sent.
    db.tombstones.clear();
    await hooks.agent_end?.(TURN, VERIFIED);
    await flush();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("the group id in every ledger query is the opaque one (never the Clerk sub)", async () => {
    vi.spyOn(ZepCloudClient.prototype, "submit").mockResolvedValue({ ref: "ep-1" });
    const { hooks } = await register();
    await hooks.agent_end?.(TURN, VERIFIED);
    await flush();
    // Every ledger query that names a group names THIS user's opaque group.
    const ledgerQueries = db.log.filter(
      (q) =>
        !isDdl(q) &&
        /lp_memory_(receipts|tombstones|pending)/i.test(q.text) &&
        /group_id\s*=/i.test(q.text),
    );
    expect(ledgerQueries.length).toBeGreaterThan(0);
    for (const q of ledgerQueries) {
      expect(q.values[0]).toBe(OPAQUE());
    }
    expect(JSON.stringify(db.log.map((q) => q.values))).not.toContain(CLERK.slice(5));
  });

  it("ROUND TRIP: after an operator forget, the same turn is never sent again (keys written = keys read)", async () => {
    const submit = vi.spyOn(ZepCloudClient.prototype, "submit").mockResolvedValue({ ref: "ep-1" });
    vi.spyOn(ZepCloudClient.prototype, "forget").mockResolvedValue(true);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-wiring-"));
    try {
      const sessions = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      // The user's transcript, as on disk: the forget tombstones every entry in it.
      fs.writeFileSync(
        path.join(sessions, "s1.jsonl"),
        TURN.messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n") + "\n",
      );
      const { hooks, runCli } = await register();
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await runCli("forget", "--user", db.userId, "--state-dir", stateDir);
      expect(process.exitCode ?? 0).toBe(0);
      // The forget wrote the KEYED form of both entries under the user's OPAQUE group
      // (the group capture reads), never the raw hashes and never another group.
      for (const item of ITEMS) {
        expect(db.tombstones).toContain(
          `${OPAQUE()}\u0000${tombstoneKey(entryHash(item), PEPPER)}`,
        );
        expect([...db.tombstones].some((t) => t.endsWith(`\u0000${entryHash(item)}`))).toBe(false);
      }
      // The live session replays the turn: capture must find the tombstones.
      await hooks.agent_end?.(TURN, VERIFIED);
      await flush();
      expect(submit).not.toHaveBeenCalled();
      // Control: without the tombstones the same turn IS sent, so the line above is the
      // tombstones at work, not a capture that would never have sent anything.
      db.tombstones.clear();
      await hooks.agent_end?.(TURN, VERIFIED);
      await flush();
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = undefined;
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
