/** afterReady: every store method awaits the schema before it runs. */
import { describe, expect, it, vi } from "vitest";
import { afterReady } from "./after-ready.js";

describe("afterReady", () => {
  it("every method waits for ready() before it runs, then passes args and the result through", async () => {
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const ready = vi.fn(async () => {
      await gate;
      order.push("ready");
    });
    const store = {
      get: vi.fn(async (g: string, n: number) => (order.push(`get:${g}:${n}`), `v_${g}`)),
      del: vi.fn(async () => (order.push("del"), 1)),
    };
    const w = afterReady(store, ready);
    const p = w.get("g1", 2);
    const q = w.del();
    await Promise.resolve();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.del).not.toHaveBeenCalled();
    open();
    expect(await p).toBe("v_g1");
    expect(await q).toBe(1);
    expect(store.get).toHaveBeenCalledWith("g1", 2);
    expect(order.indexOf("ready")).toBeLessThan(order.indexOf("get:g1:2"));
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("a failing ready() rejects the call and the method never runs", async () => {
    const store = { get: vi.fn(async () => "v") };
    const w = afterReady(store, async () => {
      throw new Error("schema down");
    });
    await expect(w.get()).rejects.toThrow("schema down");
    expect(store.get).not.toHaveBeenCalled();
  });

  it("wraps exactly the source's methods and calls each on the original object", async () => {
    const self = {
      async who() {
        return this;
      },
      async other() {
        return 1;
      },
    };
    const w = afterReady(self, async () => undefined);
    expect(Object.keys(w)).toEqual(Object.keys(self));
    expect(await w.who()).toBe(self);
  });

  it("refuses a property that is not a method", () => {
    const store = {
      n: 0,
      async inc() {
        return 1;
      },
    } as unknown as { inc: () => Promise<number> };
    expect(() => afterReady(store, async () => undefined)).toThrow(/n is not a method/);
  });

  it("refuses a class instance (its prototype methods would be dropped)", () => {
    class S {
      async get() {
        return 1;
      }
    }
    expect(() => afterReady(new S() as never, async () => undefined)).toThrow(/plain object/);
  });
});
