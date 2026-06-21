/**
 * P2 (G1) — explicit backend mode tests.
 *
 * These cover the EXPLICIT `backend` config field that replaces the implicit
 * "apiKey present => cloud" auto-detection. Resolution order:
 *   1. explicit `backend` wins
 *   2. else apiKey present => infer "zep-cloud" + emit deprecation signal
 *   3. else default => "self-hosted" (the locked PHI posture)
 *
 * Plus validation (zep-cloud needs apiKey; self-hosted needs serverUrl) and
 * the createClient switch on the resolved backend. Backward-compat for the
 * OLD createClient cfg shape (no `backend`) lives in characterization.test.ts
 * and must NOT be duplicated/altered here.
 */

import { describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import { graphitiConfigSchema } from "./config.js";
import { createClient } from "./index.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

// ============================================================================
// Parser — explicit backend resolution
// ============================================================================

describe("graphitiConfigSchema.parse — explicit backend", () => {
  it("honors explicit backend: zep-cloud (apiKey present)", () => {
    const cfg = graphitiConfigSchema.parse({ backend: "zep-cloud", apiKey: "z_key" });
    expect(cfg.backend).toBe("zep-cloud");
    expect(cfg.mode).toBe("cloud");
    expect(cfg.apiKey).toBe("z_key");
    expect(cfg.deprecationWarning).toBeUndefined();
  });

  it("honors explicit backend: self-hosted (serverUrl present, no deprecation)", () => {
    const cfg = graphitiConfigSchema.parse({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
    });
    expect(cfg.backend).toBe("self-hosted");
    expect(cfg.mode).toBe("self-hosted");
    expect(cfg.serverUrl).toBe("http://localhost:8000");
    expect(cfg.deprecationWarning).toBeUndefined();
  });

  it("honors explicit self-hosted even when an apiKey is also present (no implicit cloud)", () => {
    const cfg = graphitiConfigSchema.parse({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
      apiKey: "z_key",
    });
    expect(cfg.backend).toBe("self-hosted");
    expect(cfg.mode).toBe("self-hosted");
    expect(cfg.deprecationWarning).toBeUndefined();
  });

  it("infers zep-cloud from apiKey when backend is absent AND emits a deprecation signal", () => {
    const cfg = graphitiConfigSchema.parse({ apiKey: "z_key" });
    expect(cfg.backend).toBe("zep-cloud");
    expect(cfg.mode).toBe("cloud");
    expect(cfg.deprecationWarning).toBeDefined();
    expect(cfg.deprecationWarning).toMatch(/deprecated/i);
    expect(cfg.deprecationWarning).toMatch(/backend/i);
  });

  it("defaults to self-hosted when backend absent and no apiKey (serverUrl present)", () => {
    const cfg = graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000" });
    expect(cfg.backend).toBe("self-hosted");
    expect(cfg.mode).toBe("self-hosted");
    expect(cfg.deprecationWarning).toBeUndefined();
  });

  it("always sets a resolved backend on the returned config", () => {
    const a = graphitiConfigSchema.parse({ backend: "zep-cloud", apiKey: "z_key" });
    const b = graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000" });
    expect(a.backend).toBeTruthy();
    expect(b.backend).toBeTruthy();
  });

  it("throws a clear error when backend: zep-cloud is set without an apiKey", () => {
    expect(() =>
      graphitiConfigSchema.parse({ backend: "zep-cloud", serverUrl: "http://localhost:8000" }),
    ).toThrow(/zep-cloud.*requires.*apiKey/i);
  });

  it("throws a clear error when backend: self-hosted is set without a serverUrl", () => {
    expect(() => graphitiConfigSchema.parse({ backend: "self-hosted", apiKey: "z_key" })).toThrow(
      /self-hosted.*requires.*serverUrl/i,
    );
  });

  it("throws on an invalid backend value", () => {
    expect(() =>
      graphitiConfigSchema.parse({ backend: "nonsense", serverUrl: "http://localhost:8000" }),
    ).toThrow(/backend/i);
  });

  it("resolves env vars in apiKey under explicit zep-cloud", () => {
    vi.stubEnv("TEST_ZEP_KEY_P2", "z_resolved_p2");
    const cfg = graphitiConfigSchema.parse({ backend: "zep-cloud", apiKey: "${TEST_ZEP_KEY_P2}" });
    expect(cfg.backend).toBe("zep-cloud");
    expect(cfg.apiKey).toBe("z_resolved_p2");
  });
});

// ============================================================================
// createClient — driven by resolved backend (from a fully parsed config)
// ============================================================================

describe("createClient — resolved backend", () => {
  it("returns ZepCloudClient for a parsed config resolved to zep-cloud", () => {
    const cfg = graphitiConfigSchema.parse({ backend: "zep-cloud", apiKey: "z_key" });
    const client = createClient(cfg);
    expect(client).toBeInstanceOf(ZepCloudClient);
    expect(client.label).toBe("zep-cloud");
  });

  it("returns GraphitiRestClient for a parsed config resolved to self-hosted", () => {
    const cfg = graphitiConfigSchema.parse({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
    });
    const client = createClient(cfg);
    expect(client).toBeInstanceOf(GraphitiRestClient);
    expect(client.label).toContain("graphiti-rest");
  });

  it("selects zep-cloud by backend even when a serverUrl is also present on the config", () => {
    const cfg = graphitiConfigSchema.parse({
      backend: "zep-cloud",
      apiKey: "z_key",
      serverUrl: "http://localhost:8000",
    });
    const client = createClient(cfg);
    expect(client).toBeInstanceOf(ZepCloudClient);
  });
});
