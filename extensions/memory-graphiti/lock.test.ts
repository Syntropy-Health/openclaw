import { describe, expect, it } from "vitest";
import { createGroupLock } from "./lock.js";
import { tombstoneKey } from "./receipts.js";

describe("createGroupLock (security review: in-flight capture vs forget)", () => {
  it("a forget on group g waits for a capture of g already under way", async () => {
    const lock = createGroupLock();
    const order: string[] = [];
    let finishCapture!: () => void;
    const captureGate = new Promise<void>((r) => (finishCapture = r));
    const capture = lock(["g"], async () => {
      order.push("capture:start");
      await captureGate;
      order.push("capture:end");
    });
    const forget = lock(["g", "h"], async () => {
      order.push("forget");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["capture:start"]);
    finishCapture();
    await Promise.all([capture, forget]);
    expect(order).toEqual(["capture:start", "capture:end", "forget"]);
  });
  it("different groups do not wait on each other", async () => {
    const lock = createGroupLock();
    let hold!: () => void;
    const p = lock(["a"], () => new Promise<void>((r) => (hold = r)));
    await expect(lock(["b"], async () => "ran")).resolves.toBe("ran");
    hold();
    await p;
  });
  it("a throwing holder still releases the lock", async () => {
    const lock = createGroupLock();
    await expect(lock(["g"], async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(lock(["g"], async () => "next")).resolves.toBe("next");
  });
});

describe("tombstoneKey (security review: no dictionary confirmation without the pepper)", () => {
  it("is keyed: differs from the entry hash and depends on the pepper", () => {
    const h = "a".repeat(64);
    expect(tombstoneKey(h, "p1")).not.toBe(h);
    expect(tombstoneKey(h, "p1")).not.toBe(tombstoneKey(h, "p2"));
    expect(tombstoneKey(h, "p1")).toBe(tombstoneKey(h, "p1"));
  });
});
