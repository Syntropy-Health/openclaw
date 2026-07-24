import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import {
  DEFAULT_MODEL_CANDIDATE_TIMEOUT_MS,
  resolveModelCandidateTimeoutMs,
  runWithModelFallback,
} from "./model-fallback.js";

function makeCfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-haiku-3-5"],
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

async function expectFallsBackToHaiku(params: {
  provider: string;
  model: string;
  firstError: Error;
}) {
  const cfg = makeCfg();
  const run = vi.fn().mockRejectedValueOnce(params.firstError).mockResolvedValueOnce("ok");

  const result = await runWithModelFallback({
    cfg,
    provider: params.provider,
    model: params.model,
    run,
  });

  expect(result.result).toBe("ok");
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toBe("anthropic");
  expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
}

describe("runWithModelFallback", () => {
  it("normalizes openai gpt-5.3 codex to openai-codex before running", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.3-codex",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai-codex", "gpt-5.3-codex");
  });

  it("does not fall back on non-auth errors", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockRejectedValueOnce(new Error("bad request")).mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("bad request");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back on auth errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("nope"), { status: 401 }),
    });
  });

  it("falls back on transient HTTP 5xx errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      ),
    });
  });

  it("falls back on 402 payment required", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("payment required"), { status: 402 }),
    });
  });

  it("falls back on billing errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error(
        "LLM request rejected: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    });
  });

  it("falls back on credential validation errors", async () => {
    await expectFallsBackToHaiku({
      provider: "anthropic",
      model: "claude-opus-4",
      firstError: new Error('No credentials found for profile "anthropic:default".'),
    });
  });

  it("skips providers when all profiles are in cooldown", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-test-${crypto.randomUUID()}`;
    const profileId = `${provider}:default`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider,
          key: "test-key",
        },
      },
      usageStats: {
        [profileId]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/m1`,
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (providerId, modelId) => {
      if (providerId === "fallback") {
        return "ok";
      }
      throw new Error(`unexpected provider: ${providerId}/${modelId}`);
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider,
        model: "m1",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toEqual([["fallback", "ok-model"]]);
      expect(result.attempts[0]?.reason).toBe("rate_limit");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not skip when any profile is available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-mixed-${crypto.randomUUID()}`;
    const profileA = `${provider}:a`;
    const profileB = `${provider}:b`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileA]: {
          type: "api_key",
          provider,
          key: "key-a",
        },
        [profileB]: {
          type: "api_key",
          provider,
          key: "key-b",
        },
      },
      usageStats: {
        [profileA]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/m1`,
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (providerId) => {
      if (providerId === provider) {
        return "ok";
      }
      return "unexpected";
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider,
        model: "m1",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toEqual([[provider, "m1"]]);
      expect(result.attempts).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not append configured primary when fallbacksOverride is set", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockImplementation(() => Promise.reject(Object.assign(new Error("nope"), { status: 401 })));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: ["anthropic/claude-haiku-3-5"],
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4-5"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("uses fallbacksOverride instead of agents.defaults.model.fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as OpenClawConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    const res = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallbacksOverride: ["openai/gpt-4.1"],
      run: async (provider, model) => {
        calls.push({ provider, model });
        if (provider === "anthropic") {
          throw Object.assign(new Error("nope"), { status: 401 });
        }
        if (provider === "openai" && model === "gpt-4.1") {
          return "ok";
        }
        throw new Error(`unexpected candidate: ${provider}/${model}`);
      },
    });

    expect(res.result).toBe("ok");
    expect(calls).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "openai", model: "gpt-4.1" },
    ]);
  });

  it("treats an empty fallbacksOverride as disabling global fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as OpenClawConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: [],
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw new Error("primary failed");
        },
      }),
    ).rejects.toThrow("primary failed");

    expect(calls).toEqual([{ provider: "anthropic", model: "claude-opus-4-5" }]);
  });

  it("defaults provider/model when missing (regression #946)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];

    const result = await runWithModelFallback({
      cfg,
      provider: undefined as unknown as string,
      model: undefined as unknown as string,
      run: async (provider, model) => {
        calls.push({ provider, model });
        return "ok";
      },
    });

    expect(result.result).toBe("ok");
    expect(calls).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);
  });

  it("falls back on missing API key errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error("No API key found for profile openai."),
    });
  });

  it("falls back on lowercase credential errors", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: new Error("no api key found for profile openai"),
    });
  });

  it("falls back on timeout abort errors", async () => {
    const timeoutCause = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("aborted"), { name: "AbortError", cause: timeoutCause }),
    });
  });

  it("falls back on abort errors with timeout reasons", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("aborted"), {
        name: "AbortError",
        reason: "deadline exceeded",
      }),
    });
  });

  it("falls back when message says aborted but error is a timeout", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("request aborted"), { code: "ETIMEDOUT" }),
    });
  });

  it("falls back on provider abort errors with request-aborted messages", async () => {
    await expectFallsBackToHaiku({
      provider: "openai",
      model: "gpt-4.1-mini",
      firstError: Object.assign(new Error("Request was aborted"), { name: "AbortError" }),
    });
  });

  it("does not fall back on user aborts", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("appends the configured primary as a last fallback", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b:free",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
  });
});

describe("runWithModelFallback per-candidate timeout (issue #112i)", () => {
  it("abandons a slow/hung candidate and fails over to the next model", async () => {
    const cfg = makeCfg(); // primary openai/gpt-4.1-mini, fallback anthropic/claude-haiku-3-5
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // primary hangs (never resolves)
      .mockResolvedValueOnce("ok-from-fallback");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
      perCandidateTimeoutMs: 30,
    });

    expect(result.result).toBe("ok-from-fallback");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(result.attempts[0]?.reason).toBe("timeout");
  });

  it("does NOT abandon a slow-but-completing candidate when the timeout is disabled", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("slow-ok"), 40)),
      );

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run, // no perCandidateTimeoutMs → disabled
    });

    expect(result.result).toBe("slow-ok");
    expect(run).toHaveBeenCalledTimes(1); // primary completed, no failover
  });

  it("throws when the last candidate also times out (no fallback left)", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockImplementation(() => new Promise(() => {})); // every candidate hangs

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
        perCandidateTimeoutMs: 25,
      }),
    ).rejects.toThrow(/All models failed/);
    expect(run).toHaveBeenCalledTimes(2); // primary + fallback both attempted then timed out
  });
});

// issue #112 (re-scoped): the real defect was NOT an unbounded hang (the 120s
// gateway turn timeout already bounds it) but that a THROTTLED PRIMARY dead-waits
// to that turn timeout with NO failover — because the per-candidate timeout that
// makes failover fire was opt-in-via-env and DEFAULT-OFF. Fix = default it ON so
// the chat path fails over fast. Env stays the override knob.
describe("resolveModelCandidateTimeoutMs — default-on (issue #112)", () => {
  it("defaults ON (non-zero) when the env override is unset", () => {
    expect(resolveModelCandidateTimeoutMs({})).toBe(DEFAULT_MODEL_CANDIDATE_TIMEOUT_MS);
    expect(DEFAULT_MODEL_CANDIDATE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("keeps headroom so a 2-3 candidate chain can WALK before the 120s turn timeout", () => {
    // per_candidate * candidate-count must be < turnTimeoutMs (120s) or the turn
    // dies before failover finishes the chain (CTO scope pin #1).
    expect(DEFAULT_MODEL_CANDIDATE_TIMEOUT_MS * 3).toBeLessThan(120_000);
  });

  it("honors an explicit env override value (>0)", () => {
    expect(resolveModelCandidateTimeoutMs({ OPENCLAW_MODEL_CANDIDATE_TIMEOUT_MS: "5000" })).toBe(
      5000,
    );
  });

  it("honors explicit disable via env (0)", () => {
    expect(resolveModelCandidateTimeoutMs({ OPENCLAW_MODEL_CANDIDATE_TIMEOUT_MS: "0" })).toBe(0);
  });

  it("falls back to the default on a malformed/negative override (never silently disabled)", () => {
    expect(resolveModelCandidateTimeoutMs({ OPENCLAW_MODEL_CANDIDATE_TIMEOUT_MS: "abc" })).toBe(
      DEFAULT_MODEL_CANDIDATE_TIMEOUT_MS,
    );
    expect(resolveModelCandidateTimeoutMs({ OPENCLAW_MODEL_CANDIDATE_TIMEOUT_MS: "-1" })).toBe(
      DEFAULT_MODEL_CANDIDATE_TIMEOUT_MS,
    );
  });

  it("FIRES failover at the default timeout: a hung primary hands off to the next model (injected clock)", async () => {
    vi.useFakeTimers();
    try {
      const cfg = makeCfg();
      const run = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {})) // primary hangs (throttled/429-retry)
        .mockResolvedValueOnce("ok-from-fallback");

      const timeout = resolveModelCandidateTimeoutMs({}); // env unset → the new default
      const promise = runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
        perCandidateTimeoutMs: timeout,
      });
      // Advance the injected clock past the default → the hung primary is abandoned
      // and failover MUST fire to the next candidate (not a turn-timeout death).
      await vi.advanceTimersByTimeAsync(timeout);
      const result = await promise;

      expect(result.result).toBe("ok-from-fallback");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0]).toBe("anthropic"); // the fallback model was actually invoked
      expect(result.attempts[0]?.reason).toBe("timeout"); // failover reason surfaced
    } finally {
      vi.useRealTimers();
    }
  });
});
