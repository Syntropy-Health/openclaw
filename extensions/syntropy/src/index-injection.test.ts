import { describe, expect, it, vi } from "vitest";
import { HTTP_GATE_CHANNELS as AUTH_GATE_HTTP_CHANNELS } from "../../auth-memory-gate/src/scope.js";
import { HTTP_GATE_CHANNELS } from "../../shared/http-channels.js";
import { TtlCache } from "./cache.js";
import type { SyntropyToolResult } from "./client.js";
import {
  decideProfileInjection,
  SYNTROPY_GATE,
  SYNTROPY_GATE_HTTP,
  syntropyGateFor,
} from "./index.js";
import { CLOSE, OPEN } from "./profile.js";

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
      channel: "whatsapp",
      resolvedUsers,
      profileBlocks,
      fetchProfile,
    });

    expect(res.prependContext).toContain(OPEN);
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
    profileBlocks.set("whatsapp:+1AAA", `${OPEN}\nallergies: stale\n${CLOSE}`);
    const fetchProfile = vi.fn(async (_t: string) => okProfile("x"));

    const res = await decideProfileInjection({
      user: null,
      cacheKey: "whatsapp:+1AAA",
      channel: "whatsapp",
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
      channel: "whatsapp",
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
      channel: "whatsapp",
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
      channel: "whatsapp",
      resolvedUsers,
      profileBlocks,
      fetchProfile: fetchA,
    });
    const b = await decideProfileInjection({
      user: user("B"),
      cacheKey: "whatsapp:+1BBB",
      channel: "whatsapp",
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

// CTO #16865 (2): on HTTP surfaces (shrinemobile, webchat) chat commands do not
// dispatch, so the data gate must never send the user to `!verify` or a pairing
// code. Measured on staging 2026-10-23: a signed-in mobile user was told to type
// `!verify`, a step they could not complete.
describe("SYNTROPY_GATE on HTTP channels (CTO #16865)", () => {
  // Anything that tells the user to run a command or fetch a pairing code.
  const DEAD_END =
    /[!/]\s*verify|!identify|pair(ing)?\s+(a\s+|your\s+)?device|pairing code|6-digit|type:\s*[!/]/i;
  // The HTTP copy legitimately NAMES the forbidden steps inside its own "Do not
  // ..." prohibition. Scan the copy with every prohibition sentence removed, so a
  // future edit that tells the user to pair a device (outside a "Do not") fails.
  const withoutProhibitions = (s: string) =>
    s.replace(/Do not[^.]*\.(\s*[^.\n]*do not work here\.)?/gi, "");

  it("RED arm: the HTTP gate never tells the user to type !verify or pair a device", () => {
    expect(withoutProhibitions(SYNTROPY_GATE_HTTP)).not.toMatch(DEAD_END);
  });

  it("the prohibition strip is not a blanket eraser (an instruction outside it is caught)", () => {
    const regressed = SYNTROPY_GATE_HTTP.replace(
      "[/SYNTROPY_GATE]",
      "Ask them to pair a device first.\n[/SYNTROPY_GATE]",
    );
    expect(withoutProhibitions(regressed)).toMatch(DEAD_END);
  });

  it("control: the messaging gate DOES carry the command (so the RED arm can fail)", () => {
    expect(SYNTROPY_GATE).toMatch(DEAD_END);
  });

  it("is honest and dateless: says data linking is not available in this app yet", () => {
    expect(SYNTROPY_GATE_HTTP).toContain("[SYNTROPY_GATE]");
    expect(SYNTROPY_GATE_HTTP).toContain("status: LOCKED");
    expect(SYNTROPY_GATE_HTTP).toMatch(/not available in this app yet/i);
    expect(SYNTROPY_GATE_HTTP).not.toMatch(/\b(soon|coming|20\d\d|next (week|month))\b/i);
  });

  it.each([...HTTP_GATE_CHANNELS])("syntropyGateFor(%s) is the command-free HTTP copy", (ch) => {
    expect(syntropyGateFor(ch)).toBe(SYNTROPY_GATE_HTTP);
  });

  it.each(["whatsapp", "sms", "slack", "unknown", "", null, undefined])(
    "syntropyGateFor(%s) keeps the messaging copy",
    (ch) => {
      expect(syntropyGateFor(ch as string | null | undefined)).toBe(SYNTROPY_GATE);
    },
  );

  it("the HTTP channel list is the SAME set the identity gate uses (cannot drift)", () => {
    expect(AUTH_GATE_HTTP_CHANNELS).toBe(HTTP_GATE_CHANNELS);
    expect([...HTTP_GATE_CHANNELS].sort()).toEqual(["shrinemobile", "webchat"]);
  });

  it.each([...HTTP_GATE_CHANNELS])(
    "an unpaired %s user gets the HTTP gate through decideProfileInjection",
    async (ch) => {
      const { resolvedUsers, profileBlocks } = caches();
      const res = await decideProfileInjection({
        user: null,
        cacheKey: `${ch}:device-1`,
        channel: ch,
        resolvedUsers,
        profileBlocks,
        fetchProfile: vi.fn(),
      });
      expect(res).toEqual({ prependContext: SYNTROPY_GATE_HTTP });
    },
  );
  // Hook-level wiring (channel taken from ctx.messageProvider, not the session
  // key) is exercised behaviourally in ./hook-gate-channel.test.ts.
});
