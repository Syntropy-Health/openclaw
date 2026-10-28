import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("runWithModelFallback image-input filter", () => {
  it("drops text-only candidates before running anything", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    const result = await runWithModelFallback({
      cfg: cfgWith("p/text-a", ["p/vision-a"]),
      provider: "p",
      model: "text-a",
      imageInput: { supported },
      run,
    });
    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([["p", "vision-a"]]);
    expect(result.attempts).toEqual([]);
  });

  it("throws ImageInputUnsupportedError with 0 runs when nothing is left", async () => {
    const run = vi.fn();
    await expect(
      runWithModelFallback({
        cfg: cfgWith("p/text-a", ["p/text-b"]),
        provider: "p",
        model: "text-a",
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
        imageInput: { supported },
        run,
      }),
    ).rejects.toBeInstanceOf(ImageInputUnsupportedError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("primary in cooldown + text-only fallback + images: the typed error, 0 runs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-images-${crypto.randomUUID()}`;
    const profileId = `${provider}:default`;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: { [profileId]: { type: "api_key", provider, key: "test-key" } },
      usageStats: { [profileId]: { cooldownUntil: Date.now() + 24 * 60 * 60_000 } },
    };
    saveAuthProfileStore(store, tempDir);
    const run = vi.fn();
    try {
      await expect(
        runWithModelFallback({
          cfg: cfgWith(`${provider}/text-a`, ["fallback/text-b"]),
          provider,
          model: "text-a",
          agentDir: tempDir,
          imageInput: { supported },
          run,
        }),
      ).rejects.toBeInstanceOf(ImageInputUnsupportedError);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("without imageInput nothing is filtered", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    await runWithModelFallback({
      cfg: cfgWith("p/text-a", ["p/vision-a"]),
      provider: "p",
      model: "text-a",
      run,
    });
    expect(run.mock.calls).toEqual([["p", "text-a"]]);
  });
});
