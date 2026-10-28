import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { ImageInputUnsupportedError } from "./image-input-error.js";
import { runWithModelFallback } from "./model-fallback.js";

function cfgWith(primary: string, fallbacks: string[]): OpenClawConfig {
  return { agents: { defaults: { model: { primary, fallbacks } } } } as OpenClawConfig;
}

/** Capability table: "vision" models accept images, "text" ones do not, others unknown. */
const supported = (_provider: string, model: string) =>
  model.startsWith("vision") ? true : model.startsWith("text") ? false : undefined;

// Every test gets its own agentDir, so the developer's real auth store and cooldowns
// are never read.
const tmpDirs: string[] = [];
async function tempAgentDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-images-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Puts every profile of `provider` into cooldown until `untilMs`. */
function cooldown(agentDir: string, provider: string, untilMs: number) {
  const profileId = `${provider}:default`;
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: { [profileId]: { type: "api_key", provider, key: "test-key" } },
    usageStats: { [profileId]: { cooldownUntil: untilMs } },
  };
  saveAuthProfileStore(store, agentDir);
}

describe("runWithModelFallback image-input filter", () => {
  it("drops text-only candidates before running anything", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const result = await runWithModelFallback({
      cfg: cfgWith("p/text-a", ["p/vision-a"]),
      provider: "p",
      model: "text-a",
      agentDir: await tempAgentDir(),
      imageInput: { supported },
      run,
    });
    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([["p", "vision-a"]]);
    expect(result.attempts).toEqual([]);
  });

  it("all text-only: ImageInputUnsupportedError with 0 runs", async () => {
    const run = vi.fn();
    await expect(
      runWithModelFallback({
        cfg: cfgWith("p/text-a", ["p/text-b"]),
        provider: "p",
        model: "text-a",
        agentDir: await tempAgentDir(),
        imageInput: { supported },
        run,
      }),
    ).rejects.toBeInstanceOf(ImageInputUnsupportedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a candidate whose capability cannot be resolved (fail open)", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    await runWithModelFallback({
      cfg: cfgWith("p/unknown-a", ["p/vision-a"]),
      provider: "p",
      model: "unknown-a",
      agentDir: await tempAgentDir(),
      imageInput: { supported },
      run,
    });
    expect(run.mock.calls).toEqual([["p", "unknown-a"]]);
  });

  it("an in-runner ImageInputUnsupportedError is a normal failure, not a skip", async () => {
    const run = vi.fn().mockRejectedValueOnce(new ImageInputUnsupportedError(1));
    await expect(
      runWithModelFallback({
        cfg: cfgWith("p/unknown-a", ["p/vision-a"]),
        provider: "p",
        model: "unknown-a",
        agentDir: await tempAgentDir(),
        imageInput: { supported },
        run,
      }),
    ).rejects.toBeInstanceOf(ImageInputUnsupportedError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("vision primary IN COOLDOWN + text-only fallback: the cooldown failure, 0 runs, not the 400", async () => {
    const agentDir = await tempAgentDir();
    const provider = `cooldown-images-${crypto.randomUUID()}`;
    cooldown(agentDir, provider, Date.now() + 24 * 60 * 60_000); // far: never probed
    const run = vi.fn();
    const err = await runWithModelFallback({
      cfg: cfgWith(`${provider}/vision-a`, ["fallback/text-b"]),
      provider,
      model: "vision-a",
      agentDir,
      imageInput: { supported },
      run,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(run).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ImageInputUnsupportedError);
    expect(String((err as Error).message)).toMatch(/cooldown/);
  });

  it("a filtered-out primary does not turn the first fallback into the probed primary", async () => {
    const agentDir = await tempAgentDir();
    const provider = `cooldown-probe-${crypto.randomUUID()}`;
    // Expiry inside the probe margin: a PRIMARY in this state would be probed (run).
    cooldown(agentDir, provider, Date.now() + 30_000);
    const run = vi.fn().mockResolvedValue("ok");
    const result = await runWithModelFallback({
      cfg: cfgWith("p/text-a", [`${provider}/vision-a`, "q/vision-b"]),
      provider: "p",
      model: "text-a",
      agentDir,
      imageInput: { supported },
      run,
    });
    // vision-a is a FALLBACK in cooldown: skipped, not probed.
    expect(run.mock.calls).toEqual([["q", "vision-b"]]);
    expect(result.attempts.map((a) => a.reason)).toEqual(["rate_limit"]);
  });

  it("without imageInput nothing is filtered", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    await runWithModelFallback({
      cfg: cfgWith("p/text-a", ["p/vision-a"]),
      provider: "p",
      model: "text-a",
      agentDir: await tempAgentDir(),
      run,
    });
    expect(run.mock.calls).toEqual([["p", "text-a"]]);
  });
});
