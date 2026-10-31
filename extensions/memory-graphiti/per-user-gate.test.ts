/** Per-user single-flight + cooldown shared by the forget and highlight-remove routes. */
import { describe, expect, it } from "vitest";
import { createPerUserGate } from "./per-user-gate.js";

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("createPerUserGate", () => {
  it("a user with no history may start", () => {
    expect(createPerUserGate().refusal("u1")).toBeNull();
  });

  it("while a call runs the same user is in_progress; another user is not", async () => {
    const g = createPerUserGate({ cooldownMs: 0 });
    let release!: () => void;
    const p = g.run("u1", () => new Promise<void>((r) => (release = r)));
    expect(g.refusal("u1")).toBe("in_progress");
    expect(g.refusal("u2")).toBeNull();
    release();
    await p;
    expect(g.refusal("u1")).toBeNull();
  });

  it("the cooldown starts when the call ends and lasts exactly cooldownMs", async () => {
    const c = clock();
    const g = createPerUserGate({ cooldownMs: 5_000, now: c.now });
    c.advance(10_000); // time spent before the call does not count
    await g.run("u1", async () => {
      c.advance(3_000); // nor does time inside it
    });
    expect(g.refusal("u1")).toBe("rate_limited");
    c.advance(4_999);
    expect(g.refusal("u1")).toBe("rate_limited");
    c.advance(1);
    expect(g.refusal("u1")).toBeNull();
    expect(g.refusal("u2")).toBeNull();
  });

  it("a call that throws still frees the slot and starts the cooldown, and the error propagates", async () => {
    const c = clock();
    const g = createPerUserGate({ cooldownMs: 5_000, now: c.now });
    await expect(
      g.run("u1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(g.refusal("u1")).toBe("rate_limited");
  });

  it("run returns fn's value; the default cooldown is 5 s", async () => {
    const c = clock();
    const g = createPerUserGate({ now: c.now });
    expect(await g.run("u1", async () => 42)).toBe(42);
    c.advance(4_999);
    expect(g.refusal("u1")).toBe("rate_limited");
    c.advance(1);
    expect(g.refusal("u1")).toBeNull();
  });
});
