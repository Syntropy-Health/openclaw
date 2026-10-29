import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEmbeddedSystemPrompt, mergeHookSystemPrompt } from "./system-prompt.js";

describe("mergeHookSystemPrompt (before_agent_start systemPrompt)", () => {
  it("RED arm: no hook value returns extra unchanged (byte-identical prompt)", () => {
    expect(mergeHookSystemPrompt("caller text")).toBe("caller text");
    expect(mergeHookSystemPrompt(undefined)).toBeUndefined();
    expect(mergeHookSystemPrompt("caller text", "   ")).toBe("caller text");
    expect(mergeHookSystemPrompt(undefined, "")).toBeUndefined();
  });

  it("appends the hook text after the caller's extra prompt", () => {
    expect(mergeHookSystemPrompt("caller text", "layer text")).toBe("caller text\n\nlayer text");
  });

  it("uses the hook text alone when the caller sent none", () => {
    expect(mergeHookSystemPrompt(undefined, "  layer text  ")).toBe("layer text");
    expect(mergeHookSystemPrompt("  ", "layer text")).toBe("layer text");
  });

  it("the merged text reaches the built system prompt", () => {
    const base = { workspaceDir: "/tmp/ws", reasoningLevel: "off" as const, tools: [] };
    const without = buildEmbeddedSystemPrompt({ ...base, extraSystemPrompt: undefined } as never);
    const withLayer = buildEmbeddedSystemPrompt({
      ...base,
      extraSystemPrompt: mergeHookSystemPrompt(undefined, "LAYER-MARKER-7c1e"),
    } as never);
    expect(without).not.toContain("LAYER-MARKER-7c1e");
    expect(withLayer).toContain("LAYER-MARKER-7c1e");
  });
});

// The embedded attempt is not unit-runnable without a live agent session, so its wiring is
// pinned at the source: the build uses the early hook's systemPrompt, and the fallback path
// (early hook threw) rebuilds and re-applies with the late hook's systemPrompt.
describe("attempt.ts wiring (source pin)", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "run", "attempt.ts"), "utf8");

  it("builds the system prompt with the early hook's systemPrompt", () => {
    expect(src).toMatch(
      /buildPromptWith\(\s*mergeHookSystemPrompt\(params\.extraSystemPrompt, params\.earlyHookResult\?\.systemPrompt\),?\s*\)/,
    );
  });

  it("re-applies a late hook systemPrompt only on the fallback path", () => {
    expect(src).toMatch(
      /if \(hookFallback\) \{[\s\S]{0,400}mergeHookSystemPrompt\([\s\S]{0,120}hookResult\?\.systemPrompt[\s\S]{0,300}systemPromptText = buildPromptWith\(lateSystemPrompt\);\s*applySystemPromptOverrideToSession\(activeSession, systemPromptText\)/,
    );
  });
});
