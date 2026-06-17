import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

// Sealed-referee TDD suite (AIADLC). The `test-author` agent writes the
// challenge suite under `tests/sealed/<ws>/`; the `test-seal` hook blocks every
// other agent (incl. the implementer) from reading it. The referee runs ONLY
// this config and reports coarse pass/fail-by-category. Kept separate from the
// default vitest projects (src/**, extensions/**, test/**) so a normal
// `pnpm test` never executes — or leaks — the sealed suite.
const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: Record<string, unknown> }).test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ["tests/sealed/**/*.sealed.test.ts"],
    // Only the structural excludes; keep the base resolve aliases + setupFiles.
    exclude: ["dist/**", "**/node_modules/**", "**/vendor/**"],
    coverage: { enabled: false },
  },
});
