import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildOpenrouterProvider, resolveImplicitProviders } from "./models-config.providers.js";

// C-c ruling #2: OpenRouter is a first-class SUPPORTED provider — just
// OPENROUTER_API_KEY in env yields a working provider (default base URL + curated
// models), so staging/prod can select it via env/Infisical without bespoke config.
describe("OpenRouter implicit provider (C-c)", () => {
  it("builds with the OpenRouter base url + openai-completions api", () => {
    const p = buildOpenrouterProvider();
    expect(p.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(p.api).toBe("openai-completions");
    expect(p.models.length).toBeGreaterThan(0);
  });

  it("includes the curated default models (owl-alpha + llama-3.3-70b:free)", () => {
    const ids = buildOpenrouterProvider().models.map((m) => m.id);
    expect(ids).toContain("openrouter/owl-alpha");
    expect(ids).toContain("meta-llama/llama-3.3-70b-instruct:free");
  });

  it("is added implicitly when OPENROUTER_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const snap = captureEnv(["OPENROUTER_API_KEY"]);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.openrouter).toBeDefined();
      expect(providers?.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
      expect(providers?.openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(providers?.openrouter?.api).toBe("openai-completions");
    } finally {
      snap.restore();
    }
  });

  it("is absent when OPENROUTER_API_KEY is not set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const snap = captureEnv(["OPENROUTER_API_KEY"]);
    delete process.env.OPENROUTER_API_KEY;
    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.openrouter).toBeUndefined();
    } finally {
      snap.restore();
    }
  });

  it("does not override an explicitly-configured openrouter provider", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const snap = captureEnv(["OPENROUTER_API_KEY"]);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          openrouter: { baseUrl: "https://custom.example/v1", api: "openai-completions", models: [] },
        },
      });
      // Explicit config wins → the implicit builder must not clobber it.
      expect(providers?.openrouter).toBeUndefined();
    } finally {
      snap.restore();
    }
  });
});
