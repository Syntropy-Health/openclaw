/**
 * P3 — PHI TRIPWIRE refusal-matrix tests.
 *
 * The safety invariant under test: memory-graphiti must NEVER send real-user PHI
 * to Zep Cloud. Zep Cloud is usable ONLY when the deployment is provably QA-only
 * (the LIVE WhatsApp allow-list contains exclusively known-synthetic/QA numbers).
 * Self-hosted Graphiti (PHI in-house) is the sanctioned path and is NEVER guarded.
 *
 * Everything fails closed: anything we cannot prove QA-only refuses.
 *
 * Written test-first (red) before tripwire.ts existed; the implementation is
 * driven to green by this matrix.
 */

import { describe, expect, it, vi } from "vitest";
import type { EpisodeResult, FactResult, GraphitiMessage, MemoryClient } from "./client.js";
import { computeIsQaOnly, PhiTripwireGuard, type TripwireBreach } from "./tripwire.js";

// ============================================================================
// Fakes
// ============================================================================

/**
 * A fake inner MemoryClient that records every call so tests can assert
 * delegation (or the absence of it) precisely.
 */
function makeFakeInner(label = "fake-inner") {
  const calls = {
    addMessages: [] as Array<[string, GraphitiMessage[]]>,
    searchFacts: [] as Array<[string, (string[] | null) | undefined, number | undefined]>,
    getEpisodes: [] as Array<[string, number | undefined]>,
    healthcheck: 0,
  };

  const factsToReturn: FactResult[] = [
    {
      uuid: "f1",
      name: "pref",
      fact: "inner fact",
      valid_at: null,
      invalid_at: null,
      created_at: "2026-01-01",
      expired_at: null,
    },
  ];
  const episodesToReturn: EpisodeResult[] = [
    {
      uuid: "e1",
      name: "ep1",
      group_id: "g1",
      content: "inner episode",
      created_at: "2026-01-01",
      source: "message",
      source_description: "",
    },
  ];

  const inner: MemoryClient = {
    label,
    async addMessages(groupId, messages) {
      calls.addMessages.push([groupId, messages]);
    },
    async searchFacts(query, groupIds, maxFacts) {
      calls.searchFacts.push([query, groupIds, maxFacts]);
      return factsToReturn;
    },
    async getEpisodes(groupId, lastN) {
      calls.getEpisodes.push([groupId, lastN]);
      return episodesToReturn;
    },
    async healthcheck() {
      calls.healthcheck += 1;
      return true;
    },
  };

  return { inner, calls, factsToReturn, episodesToReturn };
}

// ============================================================================
// PhiTripwireGuard — refusal matrix
// ============================================================================

describe("PhiTripwireGuard", () => {
  it("label wraps the inner label", () => {
    const { inner } = makeFakeInner("zep-cloud");
    const guard = new PhiTripwireGuard(
      inner,
      () => true,
      () => {},
    );
    expect(guard.label).toBe("tripwire(zep-cloud)");
  });

  describe("when NOT QA-only (isQaOnly => false) — REFUSE everything PHI-bearing", () => {
    it("addMessages: inner NOT called, onBreach fired once, returns undefined, never throws", async () => {
      const { inner, calls } = makeFakeInner("zep-cloud");
      const onBreach = vi.fn();
      const guard = new PhiTripwireGuard(inner, () => false, onBreach);

      const result = await guard.addMessages("g1", [{ content: "PHI", role_type: "user" }]);

      expect(result).toBeUndefined();
      expect(calls.addMessages).toHaveLength(0); // NO network
      expect(onBreach).toHaveBeenCalledOnce();
      const breach = onBreach.mock.calls[0][0] as TripwireBreach;
      expect(breach.op).toBe("addMessages");
      expect(breach.reason).toBe("not-qa-only");
      expect(breach.backendLabel).toBe("zep-cloud");
    });

    it("searchFacts: inner NOT called, onBreach fired once, returns []", async () => {
      const { inner, calls } = makeFakeInner("zep-cloud");
      const onBreach = vi.fn();
      const guard = new PhiTripwireGuard(inner, () => false, onBreach);

      const result = await guard.searchFacts("query", ["g1"], 5);

      expect(result).toEqual([]);
      expect(calls.searchFacts).toHaveLength(0);
      expect(onBreach).toHaveBeenCalledOnce();
      expect((onBreach.mock.calls[0][0] as TripwireBreach).op).toBe("searchFacts");
    });

    it("getEpisodes: inner NOT called, onBreach fired once, returns []", async () => {
      const { inner, calls } = makeFakeInner("zep-cloud");
      const onBreach = vi.fn();
      const guard = new PhiTripwireGuard(inner, () => false, onBreach);

      const result = await guard.getEpisodes("g1", 5);

      expect(result).toEqual([]);
      expect(calls.getEpisodes).toHaveLength(0);
      expect(onBreach).toHaveBeenCalledOnce();
      expect((onBreach.mock.calls[0][0] as TripwireBreach).op).toBe("getEpisodes");
    });
  });

  describe("when QA-only (isQaOnly => true) — DELEGATE everything to inner", () => {
    it("addMessages: delegates and passes args through", async () => {
      const { inner, calls } = makeFakeInner();
      const onBreach = vi.fn();
      const guard = new PhiTripwireGuard(inner, () => true, onBreach);

      const msgs: GraphitiMessage[] = [{ content: "hi", role_type: "user" }];
      await guard.addMessages("g1", msgs);

      expect(onBreach).not.toHaveBeenCalled();
      expect(calls.addMessages).toEqual([["g1", msgs]]);
    });

    it("searchFacts: delegates, passes args, returns inner's value", async () => {
      const { inner, calls, factsToReturn } = makeFakeInner();
      const onBreach = vi.fn();
      const guard = new PhiTripwireGuard(inner, () => true, onBreach);

      const result = await guard.searchFacts("q", ["g1"], 5);

      expect(onBreach).not.toHaveBeenCalled();
      expect(calls.searchFacts).toEqual([["q", ["g1"], 5]]);
      expect(result).toBe(factsToReturn);
    });

    it("getEpisodes: delegates, passes args, returns inner's value", async () => {
      const { inner, calls, episodesToReturn } = makeFakeInner();
      const onBreach = vi.fn();
      const guard = new PhiTripwireGuard(inner, () => true, onBreach);

      const result = await guard.getEpisodes("g1", 3);

      expect(onBreach).not.toHaveBeenCalled();
      expect(calls.getEpisodes).toEqual([["g1", 3]]);
      expect(result).toBe(episodesToReturn);
    });
  });

  describe("healthcheck — always delegates (carries no PHI)", () => {
    it("delegates when NOT QA-only", async () => {
      const { inner, calls } = makeFakeInner();
      const guard = new PhiTripwireGuard(
        inner,
        () => false,
        () => {},
      );
      const result = await guard.healthcheck();
      expect(result).toBe(true);
      expect(calls.healthcheck).toBe(1);
    });

    it("delegates when QA-only", async () => {
      const { inner, calls } = makeFakeInner();
      const guard = new PhiTripwireGuard(
        inner,
        () => true,
        () => {},
      );
      await guard.healthcheck();
      expect(calls.healthcheck).toBe(1);
    });
  });

  describe("a refusal NEVER throws — even if onBreach throws, the drop is safe", () => {
    const throwingBreach = () => {
      throw new Error("onBreach blew up");
    };

    it("addMessages still drops safely (no throw out, inner not called)", async () => {
      const { inner, calls } = makeFakeInner("zep-cloud");
      const guard = new PhiTripwireGuard(inner, () => false, throwingBreach);

      await expect(
        guard.addMessages("g1", [{ content: "PHI", role_type: "user" }]),
      ).resolves.toBeUndefined();
      expect(calls.addMessages).toHaveLength(0);
    });

    it("searchFacts still returns [] (no throw out, inner not called)", async () => {
      const { inner, calls } = makeFakeInner("zep-cloud");
      const guard = new PhiTripwireGuard(inner, () => false, throwingBreach);

      await expect(guard.searchFacts("q")).resolves.toEqual([]);
      expect(calls.searchFacts).toHaveLength(0);
    });

    it("getEpisodes still returns [] (no throw out, inner not called)", async () => {
      const { inner, calls } = makeFakeInner("zep-cloud");
      const guard = new PhiTripwireGuard(inner, () => false, throwingBreach);

      await expect(guard.getEpisodes("g1")).resolves.toEqual([]);
      expect(calls.getEpisodes).toHaveLength(0);
    });
  });
});

// ============================================================================
// computeIsQaOnly — the host authority over the LIVE allow-list
// ============================================================================

// Minimal OpenClawConfig-ish builder. computeIsQaOnly only reads
// config.channels?.whatsapp?.{dmPolicy,allowFrom}.
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
// Registration gate + cloud-only wrapping — drive the real register()
// ============================================================================

import { GraphitiRestClient } from "./client.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const QA_ONLY_WHATSAPP = {
  dmPolicy: "allowlist",
  allowFrom: ["+1000000001"],
};
const REAL_WHATSAPP = {
  dmPolicy: "allowlist",
  allowFrom: ["+15551234567"], // a real number — NOT a QA number
};
const QA_NUMBERS = ["+1000000001", "+1000000002"];

type CapturedHooks = {
  before_agent_start?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
  agent_end?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
};

/**
 * Fake OpenClawPluginApi mirroring the shape characterization.test.ts uses, plus
 * a `config` carrying the live channels.whatsapp the tripwire predicate reads,
 * and an optional runtime.system.enqueueSystemEvent spy.
 */
function makeFakeApi(opts: {
  pluginConfig: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
}) {
  const hooks: CapturedHooks = {};
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const registeredTools: Array<{ name: string }> = [];
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: {
      channels: opts.whatsapp ? { whatsapp: opts.whatsapp } : {},
    } as Record<string, unknown>,
    pluginConfig: opts.pluginConfig,
    runtime: {
      system: opts.enqueueSystemEvent ? { enqueueSystemEvent: opts.enqueueSystemEvent } : undefined,
    } as Record<string, unknown>,
    logger,
    registerTool: vi.fn((tool: { name?: string }) => {
      if (tool?.name) {
        registeredTools.push({ name: tool.name });
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
  return { api, hooks, logger, registeredTools };
}

async function registerWith(opts: {
  pluginConfig: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
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
// Cloud-only wrapping — assert which client variant the hooks/tools use
//
// We can't read the closured `client` directly, so we observe wrapping through
// behavior: a self-hosted deployment ingests via the bare GraphitiRestClient
// (network spy fires); a QA-only zep-cloud deployment ingests via the guard,
// which (QA-only => true) delegates to the ZepCloudClient (its network spy
// fires). The capture hook is the observation point.
// ============================================================================

describe("cloud-only wrapping", () => {
  it("self-hosted: capture goes through the BARE GraphitiRestClient (not the guard)", async () => {
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
        whatsapp: REAL_WHATSAPP, // would refuse if it were wrapped; self-hosted is NOT
      });

      await hooks.agent_end?.(
        { success: true, messages: [{ role: "user", content: "Hello" }] },
        { messageProvider: "telegram", sessionKey: "agent:main:telegram:direct:7550356539" },
      );

      // bare client's network call fired — proves NOT guarded / not dropped
      expect(addSpy).toHaveBeenCalledOnce();
    } finally {
      addSpy.mockRestore();
    }
  });

  it("zep-cloud (QA-only): capture is WRAPPED but delegates to ZepCloudClient (QA-only => true)", async () => {
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
        { messageProvider: "telegram", sessionKey: "agent:main:telegram:direct:7550356539" },
      );

      // guard delegated to inner ZepCloudClient because the live list is QA-only
      expect(addSpy).toHaveBeenCalledOnce();
    } finally {
      addSpy.mockRestore();
    }
  });
});
