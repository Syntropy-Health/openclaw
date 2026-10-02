/**
 * Regression pin on the SHIPPED openclaw.json (the file bootstrap-config.mjs copies
 * into /data/openclaw.json on every Fly boot): ShrineAI SMS is enabled there, and no
 * credential ever lives in it (credentials are Fly secrets → env).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cfg = JSON.parse(readFileSync(resolve(ROOT, "openclaw.json"), "utf8")) as {
  plugins?: { allow?: string[]; entries?: Record<string, { enabled?: boolean; config?: unknown }> };
  channels?: Record<string, unknown>;
};

describe("shipped openclaw.json — ShrineAI SMS", () => {
  it("allows and enables the twilio plugin with smsEnabled: true (strict boolean)", () => {
    expect(cfg.plugins?.allow).toContain("twilio");
    expect(cfg.plugins?.entries?.twilio?.enabled).toBe(true);
    // keywordReplies "twilio": Twilio Advanced Opt-Out on MG…447e sends the registered
    // STOP/HELP/START copy (devex #13192 option A); openclaw only records state.
    expect(cfg.plugins?.entries?.twilio?.config).toEqual({
      smsEnabled: true,
      keywordReplies: "twilio",
    });
  });

  it("carries NO Twilio credential or number (env only)", () => {
    const text = JSON.stringify(cfg);
    expect(text).not.toMatch(/\bAC[0-9a-f]{32}\b/i);
    expect(text).not.toMatch(/\bSK[0-9a-f]{32}\b/i);
    expect(text).not.toMatch(/apiKeySecret|authToken|accountSid/);
    expect(cfg.channels?.sms).toBeUndefined();
  });
});
