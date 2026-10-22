import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { ensureAgentWorkspace } from "./workspace.js";

// openclaw-shrineai-identity R1: the shipped config points the default agent at the image's
// identity workspace with first-run bootstrap off, so the Sh'rine persona is in context and the
// bootstrap persona never is. The CTO arm (#15221): without that config, generic openclaw still
// seeds and injects BOOTSTRAP.md — the opt-in is real, not assumed.
const REPO = path.resolve(import.meta.dirname, "../..");
const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO, "openclaw.json"), "utf8"));
const SHRINE_WS = path.join(REPO, "shrine", "workspace");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Sh'rine identity workspace (R1)", () => {
  it("the shipped config uses the image identity workspace with bootstrap off", () => {
    expect(SHIPPED.agents?.defaults?.workspace).toBe("/opt/shrine/workspace");
    expect(SHIPPED.agents?.defaults?.skipBootstrap).toBe(true);
    // The workspace is read-only, so the pre-compaction memory flush (writes memory/*.md) is off.
    expect(SHIPPED.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(false);
  });

  it("with skipBootstrap, the workspace is not seeded: no BOOTSTRAP.md appears", async () => {
    const dir = tmpDir("shrine-ws-");
    fs.cpSync(SHRINE_WS, dir, { recursive: true });
    await ensureAgentWorkspace({
      dir,
      ensureBootstrapFiles: !SHIPPED.agents.defaults.skipBootstrap,
    });
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(false);
  });

  it("the run context carries Sh'rine and no bootstrap persona", async () => {
    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir: SHRINE_WS,
    });
    const soul = bootstrapFiles.find((f) => f.name === "SOUL.md");
    expect(soul?.missing).toBe(false);
    expect(soul?.content).toContain("You are Sh'rine, the AI companion of Shrine");
    const bootstrap = bootstrapFiles.find((f) => f.name === "BOOTSTRAP.md");
    expect(bootstrap?.missing ?? true).toBe(true);
    const all = contextFiles.map((f) => f.content).join("\n");
    expect(all).not.toMatch(/birth certificate|figure out who you are|Who Am I\?/i);
    expect(all).toContain("BOOTSTRAP.md` is absent on purpose");
  });

  it("CTO arm: without the identity config, a fresh workspace seeds and injects BOOTSTRAP.md", async () => {
    const dir = tmpDir("generic-ws-");
    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    expect(fs.existsSync(path.join(dir, "BOOTSTRAP.md"))).toBe(true);
    const { bootstrapFiles } = await resolveBootstrapContextForRun({ workspaceDir: dir });
    const bootstrap = bootstrapFiles.find((f) => f.name === "BOOTSTRAP.md");
    expect(bootstrap?.missing).toBe(false);
    expect(bootstrap?.content?.length ?? 0).toBeGreaterThan(0);
  });
});
