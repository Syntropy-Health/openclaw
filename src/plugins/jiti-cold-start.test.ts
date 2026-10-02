import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs build script, no type declarations
import { rewriteSpecifiers } from "../../scripts/fly/prepare-plugin-runtime.mjs";
import { resolveJitiFsCache } from "./loader.js";

describe("resolveJitiFsCache", () => {
  it("unset or blank -> true (jiti's own default; dev unchanged)", () => {
    expect(resolveJitiFsCache({})).toBe(true);
    expect(resolveJitiFsCache({ OPENCLAW_JITI_CACHE_DIR: "  " })).toBe(true);
  });
  it("set -> that directory (the image's warmed cache)", () => {
    expect(resolveJitiFsCache({ OPENCLAW_JITI_CACHE_DIR: " /app/.cache/jiti " })).toBe(
      "/app/.cache/jiti",
    );
  });
});

describe("prepare-plugin-runtime: rewriteSpecifiers", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
    dirs.push(root);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
  }

  it("rewrites relative .js -> .ts ONLY when the .ts file exists; leaves everything else", () => {
    const root = tree({
      "src/a.ts": [
        'import { b } from "./b.js";',
        'export { c } from "../lib/c.js";',
        'import real from "./real.js";',
        'import pkg from "some-package/x.js";',
        'const lazy = () => import("./b.js");',
        'import missing from "./missing.js";',
      ].join("\n"),
      "src/b.ts": "export const b = 1;",
      "lib/c.ts": "export const c = 1;",
      "src/real.js": "export default 1;",
      "src/types.d.ts": 'import { b } from "./b.js";',
      "src/node_modules/dep/i.ts": 'import { b } from "./b.js";',
      "src/node_modules/dep/b.ts": "export const b = 1;",
    });
    const r = rewriteSpecifiers([path.join(root, "src")]);
    const a = fs.readFileSync(path.join(root, "src/a.ts"), "utf8");
    expect(a).toContain('from "./b.ts"');
    expect(a).toContain('from "../lib/c.ts"');
    expect(a).toContain('import("./b.ts")');
    expect(a).toContain('from "./real.js"'); // a real .js file: untouched
    expect(a).toContain('from "some-package/x.js"'); // package specifier: untouched
    expect(a).toContain('from "./missing.js"'); // no .ts target: untouched
    expect(fs.readFileSync(path.join(root, "src/types.d.ts"), "utf8")).toContain('"./b.js"');
    expect(fs.readFileSync(path.join(root, "src/node_modules/dep/i.ts"), "utf8")).toContain(
      '"./b.js"',
    );
    expect(r).toEqual({ specifiers: 3, files: 1 });
  });

  it("is idempotent: a second pass changes nothing", () => {
    const root = tree({
      "src/a.ts": 'import { b } from "./b.js";',
      "src/b.ts": "export const b = 1;",
    });
    rewriteSpecifiers([path.join(root, "src")]);
    expect(rewriteSpecifiers([path.join(root, "src")])).toEqual({ specifiers: 0, files: 0 });
  });
});
