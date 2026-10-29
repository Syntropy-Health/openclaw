/**
 * The plugin's schema bootstrap creates every lp_memory_* table it relies on,
 * including lp_memory_recall (A&D §5): the per-turn recall record the panel reads.
 */
import { describe, expect, it } from "vitest";
import { ensureReceiptSchema } from "./receipts.js";

function recordingSql() {
  const statements: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    statements.push(strings.join("?").replace(/\s+/g, " ").trim());
    return [];
  }) as unknown as Parameters<typeof ensureReceiptSchema>[0];
  return { sql, statements };
}

describe("ensureReceiptSchema", () => {
  it("creates lp_memory_recall with the A&D §5 columns, PK (group_id, turn_id) and an index on at", async () => {
    const { sql, statements } = recordingSql();
    await ensureReceiptSchema(sql);
    const table = statements.find((s) => s.includes("CREATE TABLE IF NOT EXISTS lp_memory_recall"));
    expect(table).toBeDefined();
    for (const col of [
      "group_id TEXT NOT NULL",
      "turn_id TEXT NOT NULL",
      "items JSONB NOT NULL",
      "state TEXT NOT NULL",
      "at TIMESTAMPTZ NOT NULL DEFAULT now()",
      "PRIMARY KEY (group_id, turn_id)",
    ]) {
      expect(table).toContain(col);
    }
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS lp_memory_recall_at ON lp_memory_recall (at)",
    );
  });

  it("still creates the receipt, pending and tombstone tables", async () => {
    const { sql, statements } = recordingSql();
    await ensureReceiptSchema(sql);
    for (const t of ["lp_memory_receipts", "lp_memory_pending", "lp_memory_tombstones"]) {
      expect(statements.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${t}`))).toBe(true);
    }
  });
});
