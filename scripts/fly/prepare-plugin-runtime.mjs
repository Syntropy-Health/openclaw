#!/usr/bin/env node
/**
 * Build-time plugin cold-start preparation for the Fly image. Runs ONCE in the
 * Docker build (never in dev, never in CI tests), after `pnpm build`.
 *
 * WHY: plugins load through jiti from TypeScript source. MEASURED 2026-10-02 on
 * staging: every boot re-transpiled ~1.7k extension + core-src files into
 * os.tmpdir() (wiped on restart) on a shared CPU throttled to ~15% of a core
 * (58% steal) — ~10 minutes before the gateway listened. Profiling showed two
 * costs, fixed by two steps:
 *
 *  1. RESOLUTION (~44 s CPU of a 47 s warm load locally). Imports are written as
 *     `./x.js` but the file is `./x.ts`; jiti tries the literal path first and
 *     throws a NodeError per miss before probing extensions. We rewrite each
 *     relative `.js` specifier to `.ts` WHEN AND ONLY WHEN that `.ts` file exists,
 *     so it resolves on the first try. The module graph is unchanged: the same
 *     files are loaded, in the same jiti module cache, with the same sharing.
 *  2. TRANSPILE. We then load every configured plugin once through the real CLI
 *     (`plugins list` -> loadOpenClawPlugins), filling the jiti cache at
 *     OPENCLAW_JITI_CACHE_DIR, which is inside the image and survives restarts.
 *
 * Measured locally (same machine): cold 102 s -> 24 s CPU; warm 47 s -> 2.6 s CPU.
 * Fails the build if the cache ends up empty, so a slow image can never ship
 * silently.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPECIFIER = /((?:\bfrom|\bimport)\s*\(?\s*["'])(\.{1,2}\/[^"'\n]+?)\.js(["'])/g;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Rewrite relative `.js` specifiers to `.ts` where the `.ts` target exists. */
export function rewriteSpecifiers(dirs) {
  let specifiers = 0;
  let files = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) {
          walk(p);
        }
        continue;
      }
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".d.ts")) {
        continue;
      }
      const src = fs.readFileSync(p, "utf8");
      let changed = 0;
      const out = src.replace(SPECIFIER, (m, pre, spec, post) => {
        if (!fs.existsSync(path.resolve(path.dirname(p), `${spec}.ts`))) {
          return m;
        }
        changed += 1;
        return `${pre}${spec}.ts${post}`;
      });
      if (changed) {
        fs.writeFileSync(p, out);
        specifiers += changed;
        files += 1;
      }
    }
  };
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      walk(d);
    }
  }
  return { specifiers, files };
}

function countFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cacheDir = process.env.OPENCLAW_JITI_CACHE_DIR?.trim();
  if (!cacheDir) {
    console.error(
      "prepare-plugin-runtime: OPENCLAW_JITI_CACHE_DIR is not set; refusing to warm an unused cache",
    );
    process.exit(1);
  }
  const r = rewriteSpecifiers([path.join(root, "src"), path.join(root, "extensions")]);
  console.log(`prepare-plugin-runtime: rewrote ${r.specifiers} specifiers in ${r.files} files`);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-warm-"));
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ["dist/index.js", "plugins", "list"], {
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      DATABASE_URL: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 10 * 60_000,
  });
  const files = countFiles(cacheDir);
  console.log(
    `prepare-plugin-runtime: warm load exit=${res.status} signal=${res.signal ?? "-"} ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s, cache files=${files}`,
  );
  // EMPTY -> FAIL: an image with no cache boots slowly and nothing else would say so.
  if (files === 0) {
    console.error(String(res.stderr ?? "").slice(-2000));
    console.error(
      "prepare-plugin-runtime: jiti cache is EMPTY after the warm load — failing the build",
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
