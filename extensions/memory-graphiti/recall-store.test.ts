/**
 * RecallStore (A&D §4.6, §5; the principal's condition #17023: Postgres, so any
 * gateway instance can serve the panel). Unit arms with a recording fake sql;
 * the behaviour arms run against REAL Postgres in recall-store.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalRecallItems,
  createPgRecallStore,
  RECALL_BLOCK_MINUTES,
  RECALL_CAP_PER_GROUP,
  RECALL_TTL_MINUTES,
  toRecallItems,
  type RecallItem,
} from "./recall-store.js";
import { factFixture } from "./testing/memory-client.contract.js";

type Call = { text: string; values: unknown[] };

function recordingSql(rows: Record<string, unknown>[][] = []) {
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$").replace(/\s+/g, " ").trim(), values });
    return rows.shift() ?? [];
  }) as unknown as Parameters<typeof createPgRecallStore>[0];
  return { sql, calls };
}

const ITEMS: RecallItem[] = [
  { rank: 1, fact_id: "e_1", fact: "first", last_seen: "2026-10-20" },
  { rank: 2, fact_id: "e_2", fact: "second", last_seen: null },
];

describe("createPgRecallStore (statement shape)", () => {
  it("write is ONE statement (atomic): upsert + evict beyond the cap for the group", async () => {
    const { sql, calls } = recordingSql();
    await createPgRecallStore(sql).write("ok_g", "resp_1", ITEMS, "ready");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO lp_memory_recall");
    expect(calls[0].text).toContain("ON CONFLICT (group_id, turn_id) DO UPDATE");
    expect(calls[0].text).toContain("DELETE FROM lp_memory_recall");
    // a forget's block refuses the write, in the same statement
    expect(calls[0].text).toMatch(
      /SELECT[\s\S]*WHERE NOT EXISTS \( SELECT 1 FROM lp_memory_recall_block WHERE group_id = \$ AND until > now\(\) \)/,
    );
    // the sweep: expired rows of EVERY group (no group filter), and expired blocks
    expect(calls[0].text).toMatch(
      /DELETE FROM lp_memory_recall WHERE at < now\(\) - make_interval\(mins => \$\) RETURNING/,
    );
    expect(calls[0].text).toContain("DELETE FROM lp_memory_recall_block WHERE until < now()");
    expect(calls[0].values).toContain("ok_g");
    expect(calls[0].values).toContain(RECALL_CAP_PER_GROUP - 1);
    expect(calls[0].values).toContain(4); // keep this turn + the 4 newest others
    // eviction keeps the NEWEST: ordered by at DESC, within this group only
    expect(calls[0].text).toMatch(
      /DELETE FROM lp_memory_recall WHERE group_id = \$ AND turn_id <> \$ AND turn_id NOT IN \( SELECT turn_id FROM lp_memory_recall WHERE group_id = \$ AND turn_id <> \$ ORDER BY at DESC, turn_id DESC LIMIT \$ \)/,
    );
    expect(calls[0].values).toContainEqual(ITEMS);
  });

  it("read filters on the caller's group AND the turn, with the TTL in the query", async () => {
    const { sql, calls } = recordingSql();
    expect(await createPgRecallStore(sql).read("ok_g", "resp_1")).toBeNull();
    expect(calls[0].text).toMatch(/WHERE group_id = \$ AND turn_id = \$ AND at > now\(\)/);
    expect(calls[0].values).toEqual(["ok_g", "resp_1", 10]); // the TTL is exactly 10 minutes
    expect(RECALL_TTL_MINUTES).toBe(10);
  });

  it("latest is the newest unexpired row of the group", async () => {
    const { sql, calls } = recordingSql();
    await createPgRecallStore(sql).latest("ok_g");
    expect(calls[0].text).toMatch(
      /WHERE group_id = \$ AND at > now\(\) - make_interval\(mins => \$\) ORDER BY at DESC, turn_id DESC LIMIT 1/,
    );
    expect(calls[0].values).toEqual(["ok_g", 10]);
  });

  it("rows come back in canonical item key order (jsonb reorders keys)", async () => {
    const jsonbOrdered = ITEMS.map((i) => ({
      fact: i.fact,
      rank: i.rank,
      fact_id: i.fact_id,
      last_seen: i.last_seen,
    }));
    const { sql } = recordingSql([
      [{ turn_id: "resp_1", items: jsonbOrdered, state: "ready", at: new Date(0) }],
    ]);
    const r = await createPgRecallStore(sql).read("ok_g", "resp_1");
    expect(JSON.stringify(r?.items)).toBe(JSON.stringify(ITEMS));
    expect(r?.at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("forgetGroup erases AND blocks the group for 11 minutes, in one statement", async () => {
    const { sql, calls } = recordingSql([[{ turn_id: "a" }, { turn_id: "b" }]]);
    expect(await createPgRecallStore(sql).forgetGroup("ok_g")).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO lp_memory_recall_block");
    expect(calls[0].text).toContain("GREATEST(");
    expect(calls[0].text).toMatch(/DELETE FROM lp_memory_recall WHERE group_id = \$/);
    expect(calls[0].values).toEqual(["ok_g", RECALL_BLOCK_MINUTES, "ok_g"]);
    expect(RECALL_BLOCK_MINUTES).toBe(11);
  });

  it("deleteCitingFacts is scoped to the caller's group", async () => {
    const { sql, calls } = recordingSql();
    await createPgRecallStore(sql).deleteCitingFacts("ok_g", ["e_1"]);
    expect(calls[0].text).toMatch(/DELETE FROM lp_memory_recall WHERE group_id = \$ AND EXISTS/);
    expect(calls[0].values[0]).toBe("ok_g");
  });

  it("the sweep in write uses the same 10-minute TTL", async () => {
    const { sql, calls } = recordingSql();
    await createPgRecallStore(sql).write("ok_g", "resp_1", ITEMS, "ready");
    expect(calls[0].values[0]).toBe(10);
  });

  it("an empty fact-id list deletes nothing and issues no statement", async () => {
    const { sql, calls } = recordingSql();
    expect(await createPgRecallStore(sql).deleteCitingFacts("ok_g", [])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("toRecallItems / canonicalRecallItems", () => {
  it("maps ranked facts in order; last_seen is the valid-since date, else the created date", () => {
    const a = { ...factFixture(1, { validAt: "2026-10-20T08:00:00Z" }), rank: 1, score: 0.9 };
    const b = {
      ...factFixture(2, { validAt: null, createdAt: "2026-10-21T09:00:00Z" }),
      rank: 2,
      score: null,
    };
    expect(toRecallItems([a, b])).toEqual([
      { rank: 1, fact_id: "e_0001", fact: a.fact, last_seen: "2026-10-20" },
      { rank: 2, fact_id: "e_0002", fact: b.fact, last_seen: "2026-10-21" },
    ]);
  });

  it("canonical order drops unknown keys", () => {
    const messy = [{ last_seen: null, extra: "x", fact: "f", fact_id: "e", rank: 1 }];
    expect(JSON.stringify(canonicalRecallItems(messy))).toBe(
      '[{"rank":1,"fact_id":"e","fact":"f","last_seen":null}]',
    );
  });
});
