/**
 * P3 — PHI TRIPWIRE refusal-matrix tests (per-sender gate).
 *
 * The safety invariant under test: memory-graphiti must NEVER send real-user PHI
 * to Zep Cloud. Zep Cloud is usable ONLY for a conversation whose RESOLVED
 * SENDER is a known-synthetic/QA number. Self-hosted Graphiti (PHI in-house) is
 * the sanctioned path and is NEVER gated.
 *
 * Everything fails closed: anything we cannot prove QA-sender refuses.
 *
 * Two layers under test:
 *   1. PRIMARY  — senderZepAllowed + the wired hooks/tools (per-sender gate).
 *   2. DEFENSE  — computeIsQaOnly + the registration gate (startup fail-fast).
 */

import { describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import { graphitiConfigSchema } from "./config.js";
import { computeIsQaOnly, isCanonicalE164, senderZepAllowed } from "./tripwire.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

// ============================================================================
// senderZepAllowed — the PRIMARY per-sender gate (exact truth conditions).
//
// NEW-1: the gate keys on the host-resolved E.164 sender (ctx.senderE164),
// passed DIRECTLY — NOT on the session key (the session key collapses DMs to
// `main` under the default dmScope, so it is not a reliable sender source).
// ============================================================================

describe("senderZepAllowed", () => {
  const QA = ["+1000000001", "+1000000002"];

  it("true: a QA sender (senderE164 ∈ qaNumbers)", () => {
    expect(senderZepAllowed("+1000000001", QA)).toBe(true);
  });

  it("false: a non-QA sender (real user number not in qaNumbers)", () => {
    expect(senderZepAllowed("+15551234567", QA)).toBe(false);
  });

  it("false: empty qaNumbers even for a would-be-QA sender (drop ALL)", () => {
    expect(senderZepAllowed("+1000000001", [])).toBe(false);
  });

  it("false: null/undefined/empty/whitespace senderE164 (fail-closed)", () => {
    expect(senderZepAllowed(null, QA)).toBe(false);
    expect(senderZepAllowed(undefined, QA)).toBe(false);
    expect(senderZepAllowed("", QA)).toBe(false);
    expect(senderZepAllowed("   ", QA)).toBe(false);
  });

  it("false: an other-channel sender number not in qaNumbers", () => {
    // A paired/other-channel real user whose number is not a QA number.
    expect(senderZepAllowed("+447550356539", QA)).toBe(false);
  });

  // NEW-2: two-sided canonicalization — both senderE164 and qaNumbers are run
  // through normalizeE164 before the membership check, so there is zero format
  // asymmetry. These three inputs all canonicalize to +15555550001.
  describe("two-sided E.164 canonicalization (NEW-2)", () => {
    const QA_CANON = ["+15555550001"];

    it("true: senderE164 already canonical (+15555550001)", () => {
      expect(senderZepAllowed("+15555550001", QA_CANON)).toBe(true);
    });

    it("true: senderE164 missing the leading + (15555550001) still matches", () => {
      expect(senderZepAllowed("15555550001", QA_CANON)).toBe(true);
    });

    it("true: senderE164 as a whatsapp JID-ish form (15555550001@s.whatsapp.net)", () => {
      expect(senderZepAllowed("15555550001@s.whatsapp.net", QA_CANON)).toBe(true);
    });

    it("true: a non-canonical qaNumbers entry canonicalizes to match a canonical sender", () => {
      expect(senderZepAllowed("+15555550001", ["15555550001"])).toBe(true);
    });

    it("true: whitespace around senderE164 is trimmed/normalized before compare", () => {
      expect(senderZepAllowed("  +15555550001  ", QA_CANON)).toBe(true);
    });

    it("false: a senderE164 that canonicalizes to a non-E.164 shape never matches", () => {
      // "garbage" → normalizeE164 → "+" → not in any canonical qaSet.
      expect(senderZepAllowed("garbage", QA_CANON)).toBe(false);
    });
  });
});

// ============================================================================
// isCanonicalE164 — the validity predicate normalizeE164 itself omits.
// ============================================================================

describe("isCanonicalE164", () => {
  it("true for canonical E.164 (+ then 8..15 digits, leading non-zero)", () => {
    expect(isCanonicalE164("+15555550001")).toBe(true);
    expect(isCanonicalE164("+1000000001")).toBe(true);
  });

  it("false for the empty-ish normalize output '+' (garbage collapses here)", () => {
    expect(isCanonicalE164("+")).toBe(false);
  });

  it("false for too-short, leading-zero, or non-+ forms", () => {
    expect(isCanonicalE164("+123")).toBe(false); // too short
    expect(isCanonicalE164("+01234567")).toBe(false); // leading zero
    expect(isCanonicalE164("15555550001")).toBe(false); // no +
  });
});

// ============================================================================
// qaNumbers parse validation (NEW-2) — non-E.164 entries are REJECTED at parse.
// ============================================================================

describe("qaNumbers parse validation (NEW-2)", () => {
  function parseWith(qaNumbers: unknown) {
    return graphitiConfigSchema.parse({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
      qaNumbers,
    });
  }

  it("stores entries CANONICALIZED to E.164 (leading + added)", () => {
    const cfg = parseWith(["15555550001", "+1000000002"]);
    expect(cfg.qaNumbers).toEqual(["+15555550001", "+1000000002"]);
  });

  it("accepts a single string and a whatsapp JID-ish form, canonicalizing both", () => {
    expect(parseWith("15555550001").qaNumbers).toEqual(["+15555550001"]);
    expect(parseWith(["15555550001@s.whatsapp.net"]).qaNumbers).toEqual(["+15555550001"]);
  });

  it("THROWS when an entry cannot canonicalize to a valid E.164 (non-numeric)", () => {
    expect(() => parseWith(["+1000000001", "not-a-number"])).toThrow(/not a valid E\.164/i);
  });

  it("THROWS for a bare '@lid' / JID with no usable number", () => {
    expect(() => parseWith(["abc@lid"])).toThrow(/not a valid E\.164/i);
  });

  it("THROWS for the universal-admit '*' wildcard (collapses to '+')", () => {
    expect(() => parseWith(["*"])).toThrow(/not a valid E\.164/i);
  });

  it("ignores empty/whitespace-only entries (does not throw, drops them)", () => {
    expect(parseWith(["+1000000001", "  "]).qaNumbers).toEqual(["+1000000001"]);
  });
});

// ============================================================================
// computeIsQaOnly — the DEFENSE-IN-DEPTH registration predicate
// ============================================================================

// Minimal OpenClawConfig-ish builder. computeIsQaOnly only reads
// config.channels?.whatsapp?.{dmPolicy,allowFrom,accounts}.
function cfgWith(whatsapp: Record<string, unknown> | undefined): never {
  return (whatsapp === undefined ? { channels: {} } : { channels: { whatsapp } }) as never;
}

describe("computeIsQaOnly", () => {
  const QA = ["+1000000001", "+1000000002"];

  it("true: dmPolicy=allowlist AND every allowFrom entry is a QA number", () => {
    const cfg = cfgWith({ dmPolicy: "allowlist", allowFrom: ["+1000000001", "+1000000002"] });
    expect(computeIsQaOnly(cfg, QA)).toBe(true);
  });

  it("true: a strict subset of the QA set still QA-only", () => {
    const cfg = cfgWith({ dmPolicy: "allowlist", allowFrom: ["+1000000001"] });
    expect(computeIsQaOnly(cfg, QA)).toBe(true);
  });

  it("false: ONE allowFrom number not in qaNumbers (a real user got access)", () => {
    const cfg = cfgWith({
      dmPolicy: "allowlist",
      allowFrom: ["+1000000001", "+15551234567"],
    });
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  it("false: dmPolicy is 'open' even when allowFrom ⊆ qaNumbers", () => {
    const cfg = cfgWith({ dmPolicy: "open", allowFrom: ["+1000000001"] });
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  it("false: dmPolicy undefined even when allowFrom ⊆ qaNumbers", () => {
    const cfg = cfgWith({ allowFrom: ["+1000000001"] });
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  it("false: allowFrom empty array", () => {
    const cfg = cfgWith({ dmPolicy: "allowlist", allowFrom: [] });
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  it("false: allowFrom undefined", () => {
    const cfg = cfgWith({ dmPolicy: "allowlist" });
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  // Universal-admit idioms that the runtime treats as "allow everyone"
  // (allow-from.ts:28 empty ⇒ all; :31 "*" ⇒ all). Both MUST read as non-QA.
  it("false: allowFrom is the '*' wildcard (admits everyone at runtime)", () => {
    const cfg = cfgWith({ dmPolicy: "allowlist", allowFrom: ["*"] });
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  it("false: '*' wildcard even if qaNumbers also (mis)contains '*'", () => {
    const cfg = cfgWith({ dmPolicy: "allowlist", allowFrom: ["*"] });
    expect(computeIsQaOnly(cfg, ["*"])).toBe(false);
  });

  it("false: an enabled account with an EMPTY allowlist (admits everyone)", () => {
    const cfg = cfgWith({
      dmPolicy: "allowlist",
      allowFrom: ["+1000000001"],
      accounts: { biz: { dmPolicy: "allowlist", allowFrom: [] } },
    });
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  it("false: qaNumbers empty (nothing can be proven synthetic)", () => {
    const cfg = cfgWith({ dmPolicy: "allowlist", allowFrom: ["+1000000001"] });
    expect(computeIsQaOnly(cfg, [])).toBe(false);
  });

  it("false: channels.whatsapp absent (fail-closed)", () => {
    const cfg = cfgWith(undefined);
    expect(computeIsQaOnly(cfg, QA)).toBe(false);
  });

  it("false: channels itself absent (fail-closed)", () => {
    expect(computeIsQaOnly({} as never, QA)).toBe(false);
  });

  it("handles allowFrom given as a single string (not array)", () => {
    const ok = cfgWith({ dmPolicy: "allowlist", allowFrom: "+1000000001" });
    expect(computeIsQaOnly(ok, QA)).toBe(true);

    const bad = cfgWith({ dmPolicy: "allowlist", allowFrom: "+15551234567" });
    expect(computeIsQaOnly(bad, QA)).toBe(false);
  });

  // Multi-account is a real WhatsApp config path: each account carries its OWN
  // dmPolicy + allowFrom. Checking only the top level would be FAIL-OPEN — a real
  // user authorized via an account would slip past the gate. These pin that hole
  // closed: EVERY enabled surface must be allowlist-gated AND ⊆ qaNumbers.
  describe("multi-account surfaces (the fail-open hole)", () => {
    it("false: top-level QA-only but an enabled account allow-lists a REAL number", () => {
      const cfg = cfgWith({
        dmPolicy: "allowlist",
        allowFrom: ["+1000000001"],
        accounts: {
          biz: { dmPolicy: "allowlist", allowFrom: ["+15551234567"] }, // real user!
        },
      });
      expect(computeIsQaOnly(cfg, QA)).toBe(false);
    });

    it("false: top-level QA-only but an enabled account uses a non-allowlist policy", () => {
      const cfg = cfgWith({
        dmPolicy: "allowlist",
        allowFrom: ["+1000000001"],
        accounts: {
          biz: { dmPolicy: "pairing" }, // admits any pairer (real users)
        },
      });
      expect(computeIsQaOnly(cfg, QA)).toBe(false);
    });

    it("false: an enabled account with NO dmPolicy (defaults to pairing) is non-QA", () => {
      const cfg = cfgWith({
        dmPolicy: "allowlist",
        allowFrom: ["+1000000001"],
        accounts: { biz: { allowFrom: ["+1000000002"] } }, // dmPolicy undefined → pairing
      });
      expect(computeIsQaOnly(cfg, QA)).toBe(false);
    });

    it("true: top-level + an enabled account BOTH allowlist-gated to QA numbers", () => {
      const cfg = cfgWith({
        dmPolicy: "allowlist",
        allowFrom: ["+1000000001"],
        accounts: {
          biz: { dmPolicy: "allowlist", allowFrom: ["+1000000002"] },
        },
      });
      expect(computeIsQaOnly(cfg, QA)).toBe(true);
    });

    it("a DISABLED account is ignored even if it would admit real users", () => {
      const cfg = cfgWith({
        dmPolicy: "allowlist",
        allowFrom: ["+1000000001"],
        accounts: {
          biz: { enabled: false, dmPolicy: "open", allowFrom: ["+15551234567"] },
        },
      });
      expect(computeIsQaOnly(cfg, QA)).toBe(true);
    });
  });
});

// ============================================================================
// Registration gate (hard-fail) — drive the real register()
// ============================================================================

const QA_ONLY_WHATSAPP = {
  dmPolicy: "allowlist",
  allowFrom: ["+1000000001"],
};
const REAL_WHATSAPP = {
  dmPolicy: "allowlist",
  allowFrom: ["+15551234567"], // a real number — NOT a QA number
};
const QA_NUMBERS = ["+1000000001", "+1000000002"];

// A QA sender / a real sender driving the per-sender gate. The gate keys on
// ctx.senderE164 (the host-resolved canonical sender), NOT the session key —
// note the sessionKey here intentionally collapses to `main` (the default
// dmScope DOES this), which is exactly why senderE164 must be the gate input.
const QA_SENDER_CTX = {
  messageProvider: "whatsapp",
  sessionKey: "agent:main:main",
  senderE164: "+1000000001",
};
const REAL_SENDER_CTX = {
  messageProvider: "whatsapp",
  sessionKey: "agent:main:main",
  senderE164: "+15551234567",
};

type CapturedHooks = {
  before_agent_start?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
  agent_end?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
};

/**
 * Fake OpenClawPluginApi mirroring the shape characterization.test.ts uses, plus
 * a `config` carrying the live channels.whatsapp the registration predicate reads.
 */
function makeFakeApi(opts: {
  pluginConfig: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
}) {
  const hooks: CapturedHooks = {};
  const tools: Record<string, (toolCallId: string, params: unknown) => Promise<unknown> | unknown> =
    {};
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: {
      channels: opts.whatsapp ? { whatsapp: opts.whatsapp } : {},
    } as Record<string, unknown>,
    pluginConfig: opts.pluginConfig,
    runtime: {} as Record<string, unknown>,
    logger,
    registerTool: vi.fn((tool: unknown) => {
      const t = tool as { name?: string; execute?: (id: string, p: unknown) => unknown };
      if (t?.name && typeof t.execute === "function") {
        tools[t.name] = t.execute;
      }
    }),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => p,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (hooks as Record<string, unknown>)[name] = handler;
    },
  };
  return { api, hooks, tools, logger };
}

async function registerWith(opts: {
  pluginConfig: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
}) {
  const fake = makeFakeApi(opts);
  const mod = await import("./index.js");
  await mod.default.register(fake.api as never);
  return fake;
}

describe("registration gate (hard-fail) — zep-cloud demands provable QA-only", () => {
  it("THROWS when backend=zep-cloud and the allow-list is NOT QA-only", async () => {
    await expect(
      registerWith({
        pluginConfig: { backend: "zep-cloud", apiKey: "z_key", qaNumbers: QA_NUMBERS },
        whatsapp: REAL_WHATSAPP,
      }),
    ).rejects.toThrow(/phi_tripwire/i);
  });

  it("THROWS when backend=zep-cloud and there is no whatsapp channel at all (fail-closed)", async () => {
    await expect(
      registerWith({
        pluginConfig: { backend: "zep-cloud", apiKey: "z_key", qaNumbers: QA_NUMBERS },
        whatsapp: undefined,
      }),
    ).rejects.toThrow(/phi_tripwire/i);
  });

  it("registers OK (no throw) when backend=zep-cloud and the allow-list IS QA-only", async () => {
    await expect(
      registerWith({
        pluginConfig: { backend: "zep-cloud", apiKey: "z_key", qaNumbers: QA_NUMBERS },
        whatsapp: QA_ONLY_WHATSAPP,
      }),
    ).resolves.toBeDefined();
  });

  it("registers OK for self-hosted even with a non-QA allow-list (self-hosted is NEVER gated)", async () => {
    await expect(
      registerWith({
        pluginConfig: { backend: "self-hosted", serverUrl: "http://localhost:8000" },
        whatsapp: REAL_WHATSAPP,
      }),
    ).resolves.toBeDefined();
  });
});

// ============================================================================
// NEW-5: the cloud decision is derived from the ACTUAL constructed client
// (client instanceof ZepCloudClient), NOT cfg.backend. A cfg that builds a
// ZepCloudClient via the legacy apiKey-inference path (apiKey present, NO
// explicit `backend` field) must STILL be gated — the registration gate fires
// and the per-call gate is active.
// ============================================================================

describe("NEW-5: cloud gate tracks the constructed client, not cfg.backend", () => {
  it("legacy apiKey-inference path builds a CLOUD client → registration gate STILL fires on a non-QA allow-list", async () => {
    await expect(
      registerWith({
        // No explicit `backend` — apiKey presence infers zep-cloud (deprecated)
        // and createClient builds a ZepCloudClient. The gate must follow.
        pluginConfig: { apiKey: "z_key", qaNumbers: QA_NUMBERS },
        whatsapp: REAL_WHATSAPP,
      }),
    ).rejects.toThrow(/phi_tripwire/i);
  });

  it("legacy apiKey-inference cloud client: per-call capture gate ACTIVE — NON-QA sender's addMessages NOT called", async () => {
    const addSpy = vi.spyOn(ZepCloudClient.prototype, "addMessages").mockResolvedValue(undefined);
    try {
      const { hooks, logger } = await registerWith({
        pluginConfig: {
          // No explicit backend → inferred zep-cloud, ZepCloudClient built.
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP, // registration passes; runtime sender is real
      });

      await hooks.agent_end?.(
        { success: true, messages: [{ role: "user", content: "Hello, my BP is 140/90" }] },
        REAL_SENDER_CTX,
      );

      expect(addSpy).not.toHaveBeenCalled();
      const breachLogged = logger.error.mock.calls.some((c) =>
        String(c[0]).includes("phi_tripwire_breach"),
      );
      expect(breachLogged).toBe(true);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("legacy apiKey-inference cloud client: per-call capture gate ALLOWS a QA sender", async () => {
    const addSpy = vi.spyOn(ZepCloudClient.prototype, "addMessages").mockResolvedValue(undefined);
    try {
      const { hooks } = await registerWith({
        pluginConfig: {
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      await hooks.agent_end?.(
        { success: true, messages: [{ role: "user", content: "Hello" }] },
        QA_SENDER_CTX,
      );

      expect(addSpy).toHaveBeenCalledOnce();
    } finally {
      addSpy.mockRestore();
    }
  });
});

// ============================================================================
// PRIMARY per-sender gate — wired at every Zep-touch site (recall, capture,
// tools). Observe through the client network edge (spy on prototypes) + the
// onBreach marker (logger.error with `phi_tripwire_breach`).
// ============================================================================

describe("per-sender gate: capture (agent_end)", () => {
  it("cloud + NON-QA sender: addMessages NOT called, breach logged (no PHI write)", async () => {
    const addSpy = vi.spyOn(ZepCloudClient.prototype, "addMessages").mockResolvedValue(undefined);
    try {
      const { hooks, logger } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP, // registration passes; runtime sender is real
      });

      await hooks.agent_end?.(
        { success: true, messages: [{ role: "user", content: "Hello, my BP is 140/90" }] },
        REAL_SENDER_CTX,
      );

      expect(addSpy).not.toHaveBeenCalled();
      const breachLogged = logger.error.mock.calls.some((c) =>
        String(c[0]).includes("phi_tripwire_breach"),
      );
      expect(breachLogged).toBe(true);
      // breach must NOT carry the sender's raw number (PII)
      const anyLogHasNumber = [...logger.error.mock.calls, ...logger.warn.mock.calls].some((c) =>
        String(c[0]).includes("+15551234567"),
      );
      expect(anyLogHasNumber).toBe(false);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("cloud + QA sender: addMessages IS called (PHI write allowed for QA)", async () => {
    const addSpy = vi.spyOn(ZepCloudClient.prototype, "addMessages").mockResolvedValue(undefined);
    try {
      const { hooks } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      await hooks.agent_end?.(
        { success: true, messages: [{ role: "user", content: "Hello" }] },
        QA_SENDER_CTX,
      );

      expect(addSpy).toHaveBeenCalledOnce();
    } finally {
      addSpy.mockRestore();
    }
  });

  it("SELF-HOSTED + non-QA sender: NOT gated — addMessages still called (PHI in-house sanctioned)", async () => {
    const addSpy = vi
      .spyOn(GraphitiRestClient.prototype, "addMessages")
      .mockResolvedValue(undefined);
    try {
      const { hooks } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      await hooks.agent_end?.(
        { success: true, messages: [{ role: "user", content: "Hello" }] },
        REAL_SENDER_CTX,
      );

      expect(addSpy).toHaveBeenCalledOnce();
    } finally {
      addSpy.mockRestore();
    }
  });
});

describe("per-sender gate: recall (before_agent_start)", () => {
  it("cloud + NON-QA sender: searchFacts NOT called, no prependContext, breach logged", async () => {
    const searchSpy = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([
      {
        uuid: "f1",
        name: "pref",
        fact: "leaked",
        valid_at: null,
        invalid_at: null,
        created_at: "2026-01-01",
        expired_at: null,
      },
    ]);
    try {
      const { hooks, logger } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      const result = (await hooks.before_agent_start?.(
        { prompt: "what do you know about me?" },
        REAL_SENDER_CTX,
      )) as { prependContext?: string } | undefined;

      expect(searchSpy).not.toHaveBeenCalled();
      expect(result?.prependContext).toBeUndefined();
      const breachLogged = logger.error.mock.calls.some((c) =>
        String(c[0]).includes("phi_tripwire_breach"),
      );
      expect(breachLogged).toBe(true);
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("cloud + QA sender: searchFacts IS called", async () => {
    const searchSpy = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    try {
      const { hooks } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      await hooks.before_agent_start?.({ prompt: "what do you know about me?" }, QA_SENDER_CTX);

      expect(searchSpy).toHaveBeenCalledOnce();
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("SELF-HOSTED + non-QA sender: NOT gated — searchFacts still called", async () => {
    const searchSpy = vi.spyOn(GraphitiRestClient.prototype, "searchFacts").mockResolvedValue([]);
    try {
      const { hooks } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      await hooks.before_agent_start?.({ prompt: "what do you know about me?" }, REAL_SENDER_CTX);

      expect(searchSpy).toHaveBeenCalledOnce();
    } finally {
      searchSpy.mockRestore();
    }
  });
});

describe("per-sender gate: graphiti_* tools (no sender ctx ⇒ fail-closed on cloud)", () => {
  it("cloud: graphiti_search refuses without touching the client (no resolvable sender)", async () => {
    const searchSpy = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    try {
      const { tools, logger } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      const res = (await tools.graphiti_search?.("call-1", { query: "anything" })) as {
        details?: { refused?: string };
      };

      expect(searchSpy).not.toHaveBeenCalled();
      expect(res?.details?.refused).toBe("phi_tripwire");
      const breachLogged = logger.error.mock.calls.some((c) =>
        String(c[0]).includes("phi_tripwire_breach"),
      );
      expect(breachLogged).toBe(true);
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("cloud: graphiti_episodes refuses without touching the client", async () => {
    const epSpy = vi.spyOn(ZepCloudClient.prototype, "getEpisodes").mockResolvedValue([]);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      const res = (await tools.graphiti_episodes?.("call-1", { lastN: 5 })) as {
        details?: { refused?: string };
      };

      expect(epSpy).not.toHaveBeenCalled();
      expect(res?.details?.refused).toBe("phi_tripwire");
    } finally {
      epSpy.mockRestore();
    }
  });

  it("SELF-HOSTED: graphiti_search is NOT gated — client is called", async () => {
    const searchSpy = vi.spyOn(GraphitiRestClient.prototype, "searchFacts").mockResolvedValue([]);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      await tools.graphiti_search?.("call-1", { query: "anything" });

      expect(searchSpy).toHaveBeenCalledOnce();
    } finally {
      searchSpy.mockRestore();
    }
  });
});
