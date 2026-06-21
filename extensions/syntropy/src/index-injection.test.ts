import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.js";
import type { SyntropyToolResult } from "./client.js";
import { decideProfileInjection, SYNTROPY_GATE } from "./index.js";

// Wiring coverage for the SYN-206 Task 2 `before_agent_start` decision
// (extracted from the hook closure to be testable without a DB). Covers the
// integration invariants the sealed `resolveProfileContext` suite does not:
// paired→inject, unpaired→GATE+purge, fetch-failure→{} (never blocks reply),
// and identity scoping through the real profileBlocks cache.

type User = { userId: string; externalId: string; authToken: string };
const user = (n: string): User => ({
  userId: `u${n}`,
  externalId: `ext${n}`,
  authToken: `sj_${n}`,
});

const caches = () => ({
  resolvedUsers: new TtlCache<string, User>({ ttlMs: 60_000, maxSize: 100 }),
  profileBlocks: new TtlCache<string, string>({ ttlMs: 60_000, maxSize: 100 }),
});

const okProfile = (allergy: string): SyntropyToolResult => ({
  ok: true,
  data: {
    allergies: [allergy],
    conditions: [],
    health_goals: [],
    supplement_stack: [],
    dietary_preferences: {},
    metrics_data: {},
  },
});

describe("SYNTROPY_GATE strings (oc-hygiene #4)", () => {
  it("points to the real 'Pair Device' affordance, not the nonexistent 'Link Device'", () => {
    expect(SYNTROPY_GATE).toContain("Pair Device");
    expect(SYNTROPY_GATE).not.toContain("Link Device");
  });
  it("names the Syntropy Journals app", () => {
    expect(SYNTROPY_GATE).toContain("Syntropy Journals");
  });
});

describe("wiring/paired", () => {
  it("injects the profile as prependContext without the agent calling the tool", async () => {
    const { resolvedUsers, profileBlocks } = caches();
    const fetchProfile = vi.fn(async (_t: string) => okProfile("peanuts"));
    const u = user("1");

    const res = await decideProfileInjection({
      user: u,
      cacheKey: "whatsapp:+1AAA",
      resolvedUsers,
      profileBlocks,
      fetchProfile,
    });

    expect(res.prependContext).toContain("[SYNTROPY_PROFILE]");
    expect(res.prependContext).toContain("allergies: peanuts");
    // token threaded through; user cached for the sync tool factory
    expect(fetchProfile).toHaveBeenCalledWith("sj_1");
    expect(resolvedUsers.get("whatsapp:+1AAA")).toEqual(u);
  });
});

describe("wiring/unpaired", () => {
  it("returns the gate and PURGES both caches (no stale profile post-unpair)", async () => {
    const { resolvedUsers, profileBlocks } = caches();
    // simulate a prior pairing left in cache
    resolvedUsers.set("whatsapp:+1AAA", user("1"));
    profileBlocks.set(
      "whatsapp:+1AAA",
      "[SYNTROPY_PROFILE]\nallergies: stale\n[/SYNTROPY_PROFILE]",
    );
    const fetchProfile = vi.fn(async (_t: string) => okProfile("x"));

    const res = await decideProfileInjection({
      user: null,
      cacheKey: "whatsapp:+1AAA",
      resolvedUsers,
      profileBlocks,
      fetchProfile,
    });

    expect(res).toEqual({ prependContext: SYNTROPY_GATE });
    expect(fetchProfile).not.toHaveBeenCalled();
    expect(resolvedUsers.get("whatsapp:+1AAA")).toBeUndefined();
    expect(profileBlocks.get("whatsapp:+1AAA")).toBeUndefined();
  });
});

describe("wiring/failure-safe", () => {
  it("a profile fetch failure yields {} (never blocks) and keeps the user cached", async () => {
    const { resolvedUsers, profileBlocks } = caches();
    const fetchProfile = vi.fn(async (_t: string) => {
      throw new Error("SJ down");
    });

    const res = await decideProfileInjection({
      user: user("1"),
      cacheKey: "whatsapp:+1AAA",
      resolvedUsers,
      profileBlocks,
      fetchProfile,
    });

    expect(res).toEqual({}); // no prependContext, no throw
    // tool factory must still have the user even though the profile fetch failed
    expect(resolvedUsers.get("whatsapp:+1AAA")?.authToken).toBe("sj_1");
  });

  it("an empty profile yields {} and caches nothing", async () => {
    const { resolvedUsers, profileBlocks } = caches();
    const empty: SyntropyToolResult = {
      ok: true,
      data: {
        allergies: [],
        conditions: [],
        health_goals: [],
        supplement_stack: [],
        dietary_preferences: {},
        metrics_data: {},
      },
    };
    const res = await decideProfileInjection({
      user: user("1"),
      cacheKey: "whatsapp:+1AAA",
      resolvedUsers,
      profileBlocks,
      fetchProfile: async () => empty,
    });
    expect(res).toEqual({});
    expect(profileBlocks.get("whatsapp:+1AAA")).toBeUndefined();
  });
});

describe("wiring/identity-scope", () => {
  it("two users on distinct keys each get only their own block through the real cache", async () => {
    const { resolvedUsers, profileBlocks } = caches();
    const fetchA = vi.fn(async (_t: string) => okProfile("peanuts"));
    const fetchB = vi.fn(async (_t: string) => okProfile("shellfish"));

    const a = await decideProfileInjection({
      user: user("A"),
      cacheKey: "whatsapp:+1AAA",
      resolvedUsers,
      profileBlocks,
      fetchProfile: fetchA,
    });
    const b = await decideProfileInjection({
      user: user("B"),
      cacheKey: "whatsapp:+1BBB",
      resolvedUsers,
      profileBlocks,
      fetchProfile: fetchB,
    });

    expect(a.prependContext).toContain("allergies: peanuts");
    expect(a.prependContext).not.toContain("shellfish");
    expect(b.prependContext).toContain("allergies: shellfish");
    expect(b.prependContext).not.toContain("peanuts");
    // each key holds its own block
    expect(profileBlocks.get("whatsapp:+1AAA")).toBe(a.prependContext);
    expect(profileBlocks.get("whatsapp:+1BBB")).toBe(b.prependContext);
  });
});
