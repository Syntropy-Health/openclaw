import { describe, expect, it } from "vitest";
import { createPgOptOutStore, ensureOptOutSchema, type SqlTag } from "./optout-store.js";

/**
 * Minimal fake `postgres.Sql` — an in-memory table dispatched by the leading
 * SQL keyword. Enough to prove the store's methods are wired to the right
 * operation (INSERT→present, DELETE→absent, SELECT→lookup) without a real DB,
 * mirroring the injected-`sql` pattern of persist-user-identity's db.ts.
 */
function fakeSql() {
  const rows = new Set<string>();
  const calls: string[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ").trim().toUpperCase();
    calls.push(text.split(/\s+/).slice(0, 2).join(" "));
    const peer = String(values[0] ?? "");
    if (text.startsWith("CREATE TABLE")) return [];
    if (text.startsWith("INSERT")) {
      rows.add(peer);
      return [];
    }
    if (text.startsWith("DELETE")) {
      rows.delete(peer);
      return [];
    }
    if (text.startsWith("SELECT")) return rows.has(peer) ? [{ n: 1 }] : [];
    return [];
  };
  return Object.assign(tag, { rows, calls }) as unknown as SqlTag & {
    rows: Set<string>;
    calls: string[];
  };
}

describe("pg OptOutStore", () => {
  it("ensureOptOutSchema issues a CREATE TABLE (idempotent DDL)", async () => {
    const sql = fakeSql();
    await ensureOptOutSchema(sql);
    expect(sql.calls).toContain("CREATE TABLE");
  });

  it("round-trip: optOut → isOptedOut true; a different number stays false", async () => {
    const sql = fakeSql();
    const store = createPgOptOutStore(sql);
    expect(await store.isOptedOut("+15557654321")).toBe(false);
    await store.optOut("+15557654321");
    expect(await store.isOptedOut("+15557654321")).toBe(true);
    expect(await store.isOptedOut("+15550009999")).toBe(false);
  });

  it("optIn clears a prior opt-out", async () => {
    const sql = fakeSql();
    const store = createPgOptOutStore(sql);
    await store.optOut("+15557654321");
    await store.optIn("+15557654321");
    expect(await store.isOptedOut("+15557654321")).toBe(false);
  });

  it("isOptedOut on an unknown number is false (default-allow for never-opted numbers)", async () => {
    const sql = fakeSql();
    const store = createPgOptOutStore(sql);
    expect(await store.isOptedOut("+15550001111")).toBe(false);
  });
});
