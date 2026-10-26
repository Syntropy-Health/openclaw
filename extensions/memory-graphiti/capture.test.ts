import { describe, expect, it, vi } from "vitest";
import { captureWithReceipts } from "./capture.js";
import type { MemoryClient } from "./client.js";
import {
  contentHashOf,
  createMemoryReceiptLedger,
  entryHash,
  IngestNotConfirmedError,
  opaqueGroupId,
  type IngestItem,
} from "./receipts.js";

const G = "oc_group";
const confirmingClient = () => {
  const ingest = vi.fn(async (groupId: string, items: IngestItem[]) => {
    const entryHashes = items.map(entryHash);
    return {
      store: "fake",
      groupId,
      episodeIds: ["ep"],
      entryHashes,
      contentHash: contentHashOf(entryHashes),
      ingestedAt: "2026-10-26T00:00:00Z",
    };
  });
  return { client: { ingest } as unknown as MemoryClient, ingest };
};
const msgs = (...pairs: Array<[string, "user" | "assistant"]>) =>
  pairs.map(([content, roleType]) => ({ content, roleType }));

describe("captureWithReceipts (A&D B + C)", () => {
  it("ingests uncovered entries and records one receipt per entry hash", async () => {
    const { client, ingest } = confirmingClient();
    const ledger = createMemoryReceiptLedger();
    const r = await captureWithReceipts({
      client,
      ledger,
      groupId: G,
      messages: msgs(["hi", "user"], ["hello", "assistant"]),
      inFlight: new Set(),
    });
    expect(r).toEqual({ ingested: 2, skipped: 0, dropped: 0 });
    expect(ingest).toHaveBeenCalledOnce();
    const covered = await ledger.covered(G, [
      entryHash({ role: "user", text: "hi" }),
      entryHash({ role: "assistant", text: "hello" }),
    ]);
    expect(covered.size).toBe(2);
  });

  it("a replay of the whole session sends only what has no receipt yet", async () => {
    const { client, ingest } = confirmingClient();
    const ledger = createMemoryReceiptLedger();
    const base = msgs(["hi", "user"], ["hello", "assistant"]);
    await captureWithReceipts({ client, ledger, groupId: G, messages: base, inFlight: new Set() });
    const r = await captureWithReceipts({
      client,
      ledger,
      groupId: G,
      messages: [...base, ...msgs(["more", "user"])],
      inFlight: new Set(),
    });
    expect(r).toEqual({ ingested: 1, skipped: 2, dropped: 0 });
    expect(ingest.mock.calls[1][1]).toEqual([{ role: "user", text: "more" }]);
  });

  it("NOT confirmed ⇒ NO receipt (the content stays held), and the in-flight mark is released", async () => {
    const ingest = vi.fn(async () => {
      throw new IngestNotConfirmedError("nope", "readback_mismatch");
    });
    const ledger = createMemoryReceiptLedger();
    const inFlight = new Set<string>();
    await expect(
      captureWithReceipts({
        client: { ingest } as unknown as MemoryClient,
        ledger,
        groupId: G,
        messages: msgs(["hi", "user"]),
        inFlight,
      }),
    ).rejects.toThrow(IngestNotConfirmedError);
    expect(ledger.rows.size).toBe(0);
    expect(inFlight.size).toBe(0);
  });

  it("recovery: after a failed ingest, the next capture sends it again and receipts it", async () => {
    const ledger = createMemoryReceiptLedger();
    const failing = vi.fn(async () => {
      throw new IngestNotConfirmedError("down", "store_error");
    });
    await captureWithReceipts({
      client: { ingest: failing } as unknown as MemoryClient,
      ledger,
      groupId: G,
      messages: msgs(["hi", "user"]),
      inFlight: new Set(),
    }).catch(() => {});
    const { client } = confirmingClient();
    const r = await captureWithReceipts({
      client,
      ledger,
      groupId: G,
      messages: msgs(["hi", "user"]),
      inFlight: new Set(),
    });
    expect(r.ingested).toBe(1);
    expect(ledger.rows.size).toBe(1);
  });

  it("minimises before sending; an unsafe message is dropped, never sent", async () => {
    const { client, ingest } = confirmingClient();
    const r = await captureWithReceipts({
      client,
      ledger: createMemoryReceiptLedger(),
      groupId: G,
      messages: msgs(
        [
          "[USER_IDENTITY]\nexternal_id: user_2abcDEF345ghiJKL678mnoPQR\n[/USER_IDENTITY]\n\nhi",
          "user",
        ],
        ["[USER_IDENTITY]\nunclosed\n\noops", "user"],
      ),
      inFlight: new Set(),
    });
    expect(r).toEqual({ ingested: 1, skipped: 0, dropped: 1 });
    expect(ingest.mock.calls[0][1]).toEqual([{ role: "user", text: "hi" }]);
  });

  it("entries already in flight for the group are not sent twice concurrently", async () => {
    const { client, ingest } = confirmingClient();
    const inFlight = new Set([`${G}\u0000${entryHash({ role: "user", text: "hi" })}`]);
    const r = await captureWithReceipts({
      client,
      ledger: createMemoryReceiptLedger(),
      groupId: G,
      messages: msgs(["hi", "user"]),
      inFlight,
    });
    expect(r).toEqual({ ingested: 0, skipped: 1, dropped: 0 });
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe("receipt identity", () => {
  it("entryHash is stable and role-sensitive", () => {
    const a = entryHash({ role: "user", text: "x" });
    expect(entryHash({ role: "user", text: "x" })).toBe(a);
    expect(entryHash({ role: "assistant", text: "x" })).not.toBe(a);
  });
  it("contentHash is order-independent over the covered set", () => {
    expect(contentHashOf(["b", "a"])).toBe(contentHashOf(["a", "b"]));
    expect(contentHashOf(["a"])).not.toBe(contentHashOf(["a", "b"]));
  });
  it("opaqueGroupId never contains the raw scope and is stable", () => {
    const raw = "user_2abcDEF345ghiJKL678mnoPQR";
    expect(opaqueGroupId(raw)).toBe(opaqueGroupId(raw));
    expect(opaqueGroupId(raw)).not.toContain(raw);
    expect(opaqueGroupId(raw)).toMatch(/^oc_[0-9a-f]{32}$/);
    expect(opaqueGroupId("other")).not.toBe(opaqueGroupId(raw));
  });
  it("the memory ledger forgets a whole group and only that group", async () => {
    const ledger = createMemoryReceiptLedger();
    const r = (g: string) => ({
      store: "s",
      groupId: g,
      episodeIds: [],
      entryHashes: ["h1", "h2"],
      contentHash: "c",
      ingestedAt: "t",
    });
    await ledger.record(r("A"));
    await ledger.record(r("B"));
    expect(await ledger.deleteGroup("A")).toBe(2);
    expect((await ledger.covered("A", ["h1"])).size).toBe(0);
    expect((await ledger.covered("B", ["h1", "h2"])).size).toBe(2);
  });
});
