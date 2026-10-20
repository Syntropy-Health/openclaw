import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { identityVersion, layerResultFor, listIdentityFiles, loadLayers } from "./identity.js";

const REPO_SHRINE = path.resolve(import.meta.dirname, "../../../shrine");

function tmpShrine(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shrine-id-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

describe("platform layer (R3/R4)", () => {
  const dir = tmpShrine({
    "layers/shrinemobile.md": "MOBILE",
    "layers/webchat.md": "WEB",
    "layers/blank.md": "  ",
  });
  const layers = loadLayers(dir);

  it("selects the layer by channel, case-insensitively", () => {
    expect(layerResultFor(layers, "shrinemobile")).toEqual({ systemPrompt: "MOBILE" });
    expect(layerResultFor(layers, "WebChat")).toEqual({ systemPrompt: "WEB" });
  });

  it("unknown, absent or blank-layer channels get no layer (core only)", () => {
    expect(layerResultFor(layers, "sms")).toBeUndefined();
    expect(layerResultFor(layers, undefined)).toBeUndefined();
    expect(layerResultFor(layers, "blank")).toBeUndefined();
  });

  it("R4: the result carries ONLY systemPrompt (no tools, model, gate or permission keys)", () => {
    for (const ch of ["shrinemobile", "webchat"]) {
      expect(Object.keys(layerResultFor(layers, ch) ?? {})).toEqual(["systemPrompt"]);
    }
  });
});

describe("identity version (R5/R6)", () => {
  it("is content-derived: same content, same version; one byte changes it", () => {
    const a = tmpShrine({ "workspace/SOUL.md": "x", "layers/webchat.md": "y" });
    const b = tmpShrine({ "workspace/SOUL.md": "x", "layers/webchat.md": "y" });
    const c = tmpShrine({ "workspace/SOUL.md": "x!", "layers/webchat.md": "y" });
    expect(identityVersion(listIdentityFiles(a))).toBe(identityVersion(listIdentityFiles(b)));
    expect(identityVersion(listIdentityFiles(a))).not.toBe(identityVersion(listIdentityFiles(c)));
  });
});

describe("shipped texts match the CEO co-sign record (R5)", () => {
  const record = JSON.parse(fs.readFileSync(path.join(REPO_SHRINE, "COSIGN.json"), "utf8")) as {
    files: Record<string, { sha256: string; cosign: string | null }>;
  };
  const shipped = listIdentityFiles(REPO_SHRINE);

  it("every shipped text has a record with a matching sha256, and no record is stale", () => {
    expect(shipped.map((f) => f.rel).toSorted()).toEqual(Object.keys(record.files).toSorted());
    for (const f of shipped) {
      expect(record.files[f.rel]?.sha256, f.rel).toBe(f.sha256);
    }
  });

  it("every shipped text carries a CEO co-sign reference", () => {
    for (const f of shipped) {
      expect(record.files[f.rel]?.cosign, `${f.rel} has no CEO co-sign`).toMatch(/^CEO #\d+$/);
    }
  });

  it("the core identity ships no BOOTSTRAP.md (the first-run persona must never run)", () => {
    expect(fs.existsSync(path.join(REPO_SHRINE, "workspace", "BOOTSTRAP.md"))).toBe(false);
  });
});
