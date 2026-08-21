/**
 * #213 — offline integrity verification of generated tool-contract artifacts.
 *
 * WHY: the roster is a DO-NOT-EDIT artifact whose generator lives in a
 * DIFFERENT repository (the SyntropyHealth-Applications monorepo). Before
 * this test, nothing in THIS repo verified it: a hand-edited roster with a
 * matching TOOL_LOCALS entry compiled, passed the whole suite (tools.test.ts
 * cross-checks TOOL_DEFS against the roster file itself), and shipped via
 * deploy-fly. The motivating failure is documented and real, not
 * hypothetical: the sibling generated artifact carried hand-edited TAU_COSTS
 * matching NO upstream revision, undetected, because nothing verified it.
 *
 * HOW: the generator seals a self-hash into the file — sha256 of the content
 * with the integrity line's hex replaced by a fixed placeholder (a file
 * cannot contain its own hash otherwise; do NOT "simplify" the placeholder
 * mechanic away). This test re-derives it. It needs no manifests and no
 * network, so it can only fail for real tampering — never for environment
 * reasons.
 *
 * STATED LIMIT (keep verbatim): tamper-EVIDENT, not tamper-proof — a
 * deliberate forger can recompute it; the parent gate at gitlink bump is the
 * backstop. What this kills is the casual hand-edit that compiles, passes,
 * and ships.
 *
 * Contract shared with shared/schemas/scripts/lib/manifest-provenance.mjs —
 * placeholder string and line regex must match EXACTLY.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_HASH_PLACEHOLDER = "SELF_HASH_PLACEHOLDER";
const INTEGRITY_LINE_RE = /^\/\/ Integrity: self sha256 ([0-9a-f]{64}|SELF_HASH_PLACEHOLDER)$/m;

/** Mirror of manifest-provenance.mjs `verifySelfHash` — keep in lockstep. */
function verifySelfHash(content: string): {
  ok: boolean;
  expected: string | null;
  actual: string | null;
} {
  const m = content.match(INTEGRITY_LINE_RE);
  if (!m) return { ok: false, expected: null, actual: null };
  const expected = m[1];
  const unsealed = content.replace(
    INTEGRITY_LINE_RE,
    `// Integrity: self sha256 ${SELF_HASH_PLACEHOLDER}`,
  );
  const actual = createHash("sha256").update(unsealed, "utf8").digest("hex");
  return { ok: expected === actual, expected, actual };
}

const STAMPED_ARTIFACTS = ["generated/tool-roster.generated.ts"];

describe("#213 — generated artifacts carry a verifiable self-integrity stamp", () => {
  for (const rel of STAMPED_ARTIFACTS) {
    it(`${rel}: integrity stamp present, sealed (not placeholder), and verifies`, () => {
      const content = readFileSync(resolve(HERE, rel), "utf8");
      const m = content.match(INTEGRITY_LINE_RE);
      expect(
        m,
        "integrity line missing — artifact regenerated with a pre-#213 generator?",
      ).not.toBeNull();
      expect(m![1], "artifact shipped UNSEALED (placeholder not replaced)").not.toBe(
        SELF_HASH_PLACEHOLDER,
      );
      const res = verifySelfHash(content);
      expect(
        res.ok,
        `self-hash mismatch (expected ${res.expected}, recomputed ${res.actual}) — ` +
          "this DO-NOT-EDIT file was modified after generation. Regenerate it in the " +
          "monorepo (npm run codegen:openclaw-tool-roster in shared/schemas/) instead " +
          "of hand-editing.",
      ).toBe(true);
    });

    it(`${rel}: provenance stamp present (manifest-tree content hash)`, () => {
      const content = readFileSync(resolve(HERE, rel), "utf8");
      expect(content).toMatch(
        /^\/\/ Provenance: SJ manifest-tree sha256 [0-9a-f]{64} \(\d+ manifest files\)$/m,
      );
    });
  }

  it("the verifier itself fires on tampering (guard observed red, not assumed)", () => {
    const content = readFileSync(resolve(HERE, STAMPED_ARTIFACTS[0]), "utf8");
    const tampered = content.replace('scope: "consumer"', 'scope: "consumer" ');
    expect(tampered).not.toBe(content);
    expect(verifySelfHash(tampered).ok).toBe(false);
  });
});
