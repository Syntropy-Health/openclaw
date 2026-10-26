import { describe, expect, it, vi } from "vitest";
import { captureWithReceipts, MAX_BATCH_CHARS, toBatches } from "./capture.js";
import type { MemoryClient } from "./client.js";
import {
  contentHashOf,
  createMemoryReceiptLedger,
  entryHash,
  IngestNotConfirmedError,
  opaqueGroupId,
  type ConfirmResult,
  type IngestItem,
} from "./receipts.js";

const G = "oc_group";
const msgs = (...pairs: Array<[string, "user" | "assistant"]>) =>
  pairs.map(([content, roleType]) => ({ content, roleType }));

/** A store stand-in: `confirm` answers from a scripted queue (default: confirmed). */
function fakeStore(script: Array<ConfirmResult | Error> = []) {
  let n = 0;
  const submit = vi.fn(async (_g: string, _items: IngestItem[]) => ({ ref: `ep-${++n}` }));
  const confirm = vi.fn(async (_g: string, _items: IngestItem[], sub: { ref: string }) => {
    const next = script.shift() ?? { status: "confirmed", episodeIds: [sub.ref] };
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  const client = { label: "fake", submit, confirm } as unknown as MemoryClient;
  return { client, submit, confirm };
}
const run = (
  client: MemoryClient,
  ledger = createMemoryReceiptLedger(),
  m = msgs(["hi", "user"]),
) => captureWithReceipts({ client, ledger, groupId: G, messages: m, inFlight: new Set() });

describe("captureWithReceipts (A&D B + C)", () => {
  it("submits uncovered entries, then receipts them on a confirmed read-back", async () => {
    const { client, submit } = fakeStore();
    const ledger = createMemoryReceiptLedger();
    const r = await run(client, ledger, msgs(["hi", "user"], ["hello", "assistant"]));
    expect(r).toMatchObject({ sent: 2, confirmed: 2, skipped: 0, dropped: 0 });
    expect(submit).toHaveBeenCalledOnce();
    expect(ledger.rows.size).toBe(2);
    expect(ledger.pend.size).toBe(0);
  });

  it("a whole-session replay sends only what has no receipt yet", async () => {
    const { client, submit } = fakeStore();
    const ledger = createMemoryReceiptLedger();
    const base = msgs(["hi", "user"], ["hello", "assistant"]);
    await run(client, ledger, base);
    const r = await run(client, ledger, [...base, ...msgs(["more", "user"])]);
    expect(r).toMatchObject({ sent: 1, confirmed: 1, skipped: 2 });
    expect(submit.mock.calls[1][1]).toEqual([{ role: "user", text: "more" }]);
  });

  it("still processing ⇒ no receipt, recorded as PENDING; the next turn re-CHECKS, never re-sends", async () => {
    const { client, submit, confirm } = fakeStore([{ status: "pending" }]);
    const ledger = createMemoryReceiptLedger();
    const r1 = await run(client, ledger);
    expect(r1).toMatchObject({ sent: 1, confirmed: 0 });
    expect(ledger.rows.size).toBe(0);
    expect([...ledger.pend.values()]).toEqual(["ep-1"]);
    const r2 = await run(client, ledger);
    expect(submit).toHaveBeenCalledOnce(); // no duplicate at the store
    expect(confirm.mock.calls[1][2]).toEqual({ ref: "ep-1" });
    expect(r2).toMatchObject({ sent: 0, confirmed: 1 });
    expect(ledger.rows.size).toBe(1);
    expect(ledger.pend.size).toBe(0);
  });

  it("a transient read-back failure keeps the submission pending (re-checked, not re-sent)", async () => {
    const { client, submit } = fakeStore([
      { status: "pending" },
      new IngestNotConfirmedError("timeout", "store_error"),
    ]);
    const ledger = createMemoryReceiptLedger();
    await run(client, ledger);
    await run(client, ledger);
    expect(submit).toHaveBeenCalledOnce();
    expect(ledger.pend.size).toBe(1);
  });

  it("a read-back MISMATCH clears the pending row, and the next turn re-sends cleanly", async () => {
    const { client, submit } = fakeStore([
      { status: "pending" },
      new IngestNotConfirmedError("differs", "readback_mismatch"),
    ]);
    const ledger = createMemoryReceiptLedger();
    await run(client, ledger);
    const r2 = await run(client, ledger);
    expect(r2.mismatched).toBe(1);
    expect(ledger.pend.size).toBe(0);
    await run(client, ledger);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(ledger.rows.size).toBe(1);
  });

  it("a store refusal: no receipt, no pending, the error surfaces; the in-flight mark is released", async () => {
    const submit = vi.fn(async () => {
      throw new IngestNotConfirmedError("503", "store_error");
    });
    const ledger = createMemoryReceiptLedger();
    const inFlight = new Set<string>();
    await expect(
      captureWithReceipts({
        client: { label: "fake", submit, confirm: vi.fn() } as unknown as MemoryClient,
        ledger,
        groupId: G,
        messages: msgs(["hi", "user"]),
        inFlight,
      }),
    ).rejects.toThrow(IngestNotConfirmedError);
    expect(ledger.rows.size).toBe(0);
    expect(ledger.pend.size).toBe(0);
    expect(inFlight.size).toBe(0);
  });

  it("minimises before sending; an unsafe message is dropped, never sent", async () => {
    const { client, submit } = fakeStore();
    const r = await run(
      client,
      undefined,
      msgs(
        [
          "[USER_IDENTITY]\nexternal_id: user_2abcDEF345ghiJKL678mnoPQR\n[/USER_IDENTITY]\n\nhi",
          "user",
        ],
        ["[USER_IDENTITY]\nunclosed\n\noops", "user"],
      ),
    );
    expect(r).toMatchObject({ sent: 1, dropped: 1 });
    expect(submit.mock.calls[0][1]).toEqual([{ role: "user", text: "hi" }]);
  });

  it("entries already in flight for the group are not sent twice concurrently", async () => {
    const { client, submit } = fakeStore();
    const r = await captureWithReceipts({
      client,
      ledger: createMemoryReceiptLedger(),
      groupId: G,
      messages: msgs(["hi", "user"]),
      inFlight: new Set([`${G}\u0000${entryHash({ role: "user", text: "hi" })}`]),
    });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(submit).not.toHaveBeenCalled();
  });

  it("a backlog larger than one batch is split into size-capped batches, each receipted", async () => {
    const { client, submit } = fakeStore();
    const big = "x".repeat(Math.floor(MAX_BATCH_CHARS / 3));
    const ledger = createMemoryReceiptLedger();
    const r = await run(
      client,
      ledger,
      msgs(
        [`${big}1`, "user"],
        [`${big}2`, "assistant"],
        [`${big}3`, "user"],
        [`${big}4`, "assistant"],
      ),
    );
    expect(submit.mock.calls.length).toBeGreaterThan(1);
    expect(r).toMatchObject({ sent: 4, confirmed: 4 });
  });

  it("a single entry too long for any batch is HELD (counted), never sent", async () => {
    const { client, submit } = fakeStore();
    const r = await run(client, undefined, msgs(["y".repeat(MAX_BATCH_CHARS + 1), "assistant"]));
    expect(r.tooLong).toBe(1);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("toBatches", () => {
  it("keeps order, never exceeds the cap, and separates oversized items", () => {
    const items = [
      { role: "user" as const, text: "a".repeat(5000) },
      { role: "assistant" as const, text: "b".repeat(5000) },
      { role: "user" as const, text: "c".repeat(MAX_BATCH_CHARS + 10) },
      { role: "assistant" as const, text: "d" },
    ];
    const { batches, tooLong } = toBatches(items);
    expect(tooLong.map((i) => i.text[0])).toEqual(["c"]);
    expect(batches.flat().map((i) => i.text[0])).toEqual(["a", "b", "d"]);
    expect(batches.length).toBe(2);
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
  });
  it("a keyed (peppered) id differs from the unkeyed one and depends on the pepper", () => {
    const raw = "user_2abcDEF345ghiJKL678mnoPQR";
    expect(opaqueGroupId(raw, "p1")).toMatch(/^ok_[0-9a-f]{32}$/);
    expect(opaqueGroupId(raw, "p1")).not.toBe(opaqueGroupId(raw));
    expect(opaqueGroupId(raw, "p1")).not.toBe(opaqueGroupId(raw, "p2"));
  });
  it("the memory ledger forgets a whole group (receipts and pending) and only that group", async () => {
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
    await ledger.addPending("A", ["h3"], "ep", "s");
    expect(await ledger.deleteGroup("A")).toBe(2);
    expect((await ledger.covered("A", ["h1"])).size).toBe(0);
    expect((await ledger.pending("A", ["h3"])).size).toBe(0);
    expect((await ledger.covered("B", ["h1", "h2"])).size).toBe(2);
  });
});
