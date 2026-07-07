/**
 * Guard for the committed deploy config (`openclaw.json`).
 *
 * `openclaw.json` is the source-of-truth that fly.toml bootstraps onto the Fly
 * volume on first boot, so an invalid key here crash-loops the gateway at
 * startup (config validation is fail-closed) even when the change that
 * introduced it was unrelated. This test runs the SAME validation the gateway
 * runs, so schema drift that would wedge startup is caught in CI instead of on
 * a live deploy.
 *
 * Regression: `channels.whatsapp.enabled` (invalid — WhatsAppConfigSchema is
 * strict and enablement is by presence, not an `enabled` key) shipped in the
 * committed config and crash-looped staging on the first redeploy after the
 * schema tightened.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateConfigObject } from "./validation.js";

describe("committed deploy config (openclaw.json)", () => {
  test("validates against the gateway config schema — no startup-wedging keys", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../../openclaw.json", import.meta.url), "utf8"),
    );
    const result = validateConfigObject(raw);
    // Surface the offending keys in the failure message rather than a bare `false`.
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
