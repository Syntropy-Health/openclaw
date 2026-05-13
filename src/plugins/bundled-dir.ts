import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debugLoader } from "./debug-loader.js";

export function resolveBundledPluginsDir(): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    debugLoader(`bundledPluginsDir resolved via env override: ${override}`);
    return override;
  }

  // bun --compile: ship a sibling `extensions/` next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const sibling = path.join(execDir, "extensions");
    if (fs.existsSync(sibling)) {
      debugLoader(`bundledPluginsDir resolved via execDir sibling: ${sibling}`);
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: walk up from this module to find `extensions/` at the package root.
  try {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (fs.existsSync(candidate)) {
        debugLoader(`bundledPluginsDir resolved via walk-up (depth=${i}): ${candidate}`);
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  debugLoader(`bundledPluginsDir UNRESOLVED — no extensions/ found from any branch`);
  return undefined;
}
