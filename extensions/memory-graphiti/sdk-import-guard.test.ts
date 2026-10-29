/**
 * G4 / R1 guard: the Zep SDK is imported in exactly one file, zep-cloud-client.ts.
 * Every other module talks to the MemoryClient interface, so a backend swap (the
 * GCP graphiti track) never has to chase SDK types through the plugin.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SDK = "@getzep"; // a bare string: the matcher looks for import forms only
const ALLOWED = new Set(["zep-cloud-client.ts"]);
const SOURCE = /\.(c|m)?(t|j)sx?$/;

/** import … from "<sdk>…", import "<sdk>…", import("<sdk>…"), require("<sdk>…"), export … from. */
const IMPORT_RE = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'\`]` + SDK.replace("/", "\\/"),
);

/** A relative path in POSIX form, whatever the platform separator (Windows reports `\\`). */
export function toPosixPath(rel: string, sep: string = path.sep): string {
  return rel.split(sep).join("/");
}

/** Files under `root` (POSIX relative paths, node_modules skipped) that import the SDK. */
export function filesImportingSdk(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SOURCE.test(entry.name) && IMPORT_RE.test(fs.readFileSync(full, "utf8"))) {
        hits.push(toPosixPath(path.relative(root, full)));
      }
    }
  };
  walk(root);
  return hits.toSorted();
}

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));

describe("Zep SDK import guard", () => {
  it("only zep-cloud-client.ts imports the Zep SDK", () => {
    const hits = filesImportingSdk(EXTENSION_ROOT);
    expect(hits.filter((f) => !ALLOWED.has(f))).toEqual([]);
    expect(hits).toContain("zep-cloud-client.ts"); // control: the matcher sees the real one
  });

  it("reports POSIX relative paths on every platform", () => {
    expect(toPosixPath("highlights\\static.ts", "\\")).toBe("highlights/static.ts");
    expect(toPosixPath("highlights/static.ts", "/")).toBe("highlights/static.ts");
  });

  it("RED arm: a planted import in any other file is detected, in every import form", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-sdk-guard-"));
    try {
      fs.mkdirSync(path.join(dir, "highlights"));
      const forms = {
        "highlights/static.ts": `import { ZepClient } from "${SDK}/zep-cloud";\n`,
        "dynamic.ts": `const m = await import('${SDK}/zep-cloud');\n`,
        "side-effect.ts": `import "${SDK}/zep-cloud";\n`,
        "reexport.ts": `export { ZepClient } from "${SDK}/zep-cloud";\n`,
        "cjs.js": `const z = require("${SDK}/zep-cloud");\n`,
        "zep-cloud-client.ts": `import { ZepClient } from "${SDK}/zep-cloud";\n`,
        "comment-only.ts": `// mentions ${SDK}/zep-cloud in prose, imports nothing\n`,
      };
      for (const [name, body] of Object.entries(forms)) {
        fs.writeFileSync(path.join(dir, name), body);
      }
      const hits = filesImportingSdk(dir);
      expect(hits.filter((f) => !ALLOWED.has(f))).toEqual([
        "cjs.js",
        "dynamic.ts",
        "highlights/static.ts",
        "reexport.ts",
        "side-effect.ts",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
