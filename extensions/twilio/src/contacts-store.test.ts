import { describe, expect, it } from "vitest";
import { createPgContactStore, ensureContactSchema } from "./contacts-store.js";
import { type SqlTag } from "./optout-store.js";

/** A fake tag that records the SQL text and serves a scripted row set per call. */
function fakeSql(results: unknown[][]) {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const tag: SqlTag = async (strings, ...values) => {
    seen.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return results.shift() ?? [];
  };
  return { tag, seen };
}

describe("pg first-contact store", () => {
  it("DDL creates lp_sms_contacts idempotently, keyed by the peer id", async () => {
    const { tag, seen } = fakeSql([]);
    await ensureContactSchema(tag);
    expect(seen[0].text).toContain("CREATE TABLE IF NOT EXISTS lp_sms_contacts");
    expect(seen[0].text).toContain("channel_peer_id VARCHAR(512) PRIMARY KEY");
  });

  it("first contact = the atomic INSERT returned a row; seen = it returned none", async () => {
    const { tag, seen } = fakeSql([[{ channel_peer_id: "+15550000001" }], []]);
    const store = createPgContactStore(tag);
    await expect(store.recordFirstContact("+15550000001")).resolves.toBe(true);
    await expect(store.recordFirstContact("+15550000001")).resolves.toBe(false);
    expect(seen[0].text).toContain(
      "ON CONFLICT (channel_peer_id) DO NOTHING RETURNING channel_peer_id",
    );
    expect(seen[0].values).toEqual(["+15550000001"]);
  });

  it("hasContact reads the row; forgetContact deletes it (parameterised)", async () => {
    const { tag, seen } = fakeSql([[{ "?column?": 1 }], [], []]);
    const store = createPgContactStore(tag);
    await expect(store.hasContact("+15550000001")).resolves.toBe(true);
    await expect(store.hasContact("+15550000002")).resolves.toBe(false);
    await store.forgetContact("+15550000001");
    expect(seen[0].text).toContain("SELECT 1 FROM lp_sms_contacts WHERE channel_peer_id = ?");
    expect(seen[2].text).toBe("DELETE FROM lp_sms_contacts WHERE channel_peer_id = ?");
    expect(seen[2].values).toEqual(["+15550000001"]);
  });
});
