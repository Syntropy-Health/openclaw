/**
 * The shipped openclaw.json must be a FIXED POINT of plugin auto-enable.
 *
 * scripts/fly/bootstrap-config.mjs copies this file's `plugins` block into
 * /data/openclaw.json on EVERY Fly boot. If auto-enable then adds anything
 * (it did: whatsapp + slack, because `channels.whatsapp` / `channels.slack` are
 * configured), the gateway rewrites /data/openclaw.json on every boot with a new
 * hash, and the next boot resets it again (CTO #13223, MEASURED: data mtime ==
 * boot time, image allow lacked slack, entries lacked whatsapp/slack).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shipped = JSON.parse(readFileSync(resolve(ROOT, "openclaw.json"), "utf8")) as OpenClawConfig;

describe("shipped openclaw.json is a fixed point of plugin auto-enable", () => {
  it("RED arm: its own channels config DOES trigger auto-enable when the entries are missing", () => {
    const stripped = structuredClone(shipped) as OpenClawConfig & {
      plugins: { allow: string[]; entries: Record<string, unknown> };
    };
    stripped.plugins.allow = stripped.plugins.allow.filter((p) => p !== "slack");
    delete stripped.plugins.entries.whatsapp;
    delete stripped.plugins.entries.slack;
    const r = applyPluginAutoEnable({ config: stripped, env: {} });
    expect(r.changes.length).toBeGreaterThan(0);
  });

  it.each([
    ["no channel env", {}],
    ["Slack/WhatsApp credentials present", { SLACK_BOT_TOKEN: "x", SLACK_APP_TOKEN: "y" }],
  ])("the shipped config produces NO auto-enable changes (%s)", (_label, env) => {
    const r = applyPluginAutoEnable({ config: shipped, env });
    expect(r.changes).toEqual([]);
  });
});
