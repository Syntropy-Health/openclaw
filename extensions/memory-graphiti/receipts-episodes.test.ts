/** The in-memory ledger's episode lookup matches the Postgres one (receipts.integration.test.ts). */
import { describe, expect, it } from "vitest";
import { createMemoryReceiptLedger } from "./receipts.js";

describe("memory ledger entryHashesForEpisodes", () => {
  it("returns the group's entry hashes citing any episode, and counts untracked episodes", async () => {
    const ledger = createMemoryReceiptLedger();
    const base = { store: "zep-cloud", contentHash: "c", ingestedAt: "2026-10-29T00:00:00Z" };
    await ledger.record({
      ...base,
      groupId: "g",
      entryHashes: ["h_a1", "h_a2"],
      episodeIds: ["ep_a"],
    });
    await ledger.record({
      ...base,
      groupId: "g",
      entryHashes: ["h_b"],
      episodeIds: ["ep_b", "ep_c"],
    });
    await ledger.record({
      ...base,
      groupId: "g_other",
      entryHashes: ["h_x"],
      episodeIds: ["ep_a"],
    });
    const r = await ledger.entryHashesForEpisodes("g", ["ep_a", "ep_c", "ep_none"]);
    expect(r.hashes.toSorted()).toEqual(["h_a1", "h_a2", "h_b"]);
    expect(r.untracked).toBe(1);
    expect(await ledger.entryHashesForEpisodes("g", [])).toEqual({ hashes: [], untracked: 0 });
  });
});
