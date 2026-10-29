/**
 * Narration guard (A&D §4.5): a TS port of SJ's assert_narration_safe. The
 * shared corpus is the parity contract; SJ runs the same file against the
 * Python guard, so a change on either side that diverges fails a test.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { NARRATION_GUARD_SOURCE, checkNarration, isNarrationSafe } from "./narration-guard.js";

type Corpus = {
  source: { blob: string; guard_version: string };
  pass: string[];
  fail: string[];
};

const corpus = JSON.parse(
  fs.readFileSync(new URL("./narration-guard.fixtures.json", import.meta.url), "utf8"),
) as Corpus;

describe("narration guard: shared corpus", () => {
  it("the corpus and the port name the same SJ source", () => {
    expect(corpus.source.blob).toBe(NARRATION_GUARD_SOURCE.blob);
    expect(corpus.source.guard_version).toBe(NARRATION_GUARD_SOURCE.guardVersion);
    expect(corpus.pass.length).toBeGreaterThan(10);
    expect(corpus.fail.length).toBeGreaterThan(20);
  });

  for (const text of corpus.pass) {
    it(`passes: ${JSON.stringify(text)}`, () => {
      expect(checkNarration(text)).toEqual({ ok: true });
    });
  }

  for (const text of corpus.fail) {
    it(`rejects: ${JSON.stringify(text)}`, () => {
      expect(isNarrationSafe(text)).toBe(false);
    });
  }
});

describe("narration guard: RED arm and result shape", () => {
  it("dose advice and diagnosis framing planted in model output are both rejected", () => {
    expect(checkNarration("Great news, you should take 400 mg magnesium tonight.")).toMatchObject({
      ok: false,
    });
    expect(checkNarration("The pattern may indicate a diagnosis worth checking.")).toMatchObject({
      ok: false,
      kind: "banned_term",
      term: "diagnosis",
    });
  });

  it("an imperative dose with no lexicon word is caught by the structural check", () => {
    expect(checkNarration("Take 500 mg before bed.")).toEqual({
      ok: false,
      kind: "imperative_dose",
      term: "take 500 mg",
    });
  });

  it("the disclaimer excision stops at the disclaimer: a smuggled clause after it is still scanned", () => {
    expect(checkNarration("Not a recommendation — you should rest.")).toMatchObject({
      ok: false,
      term: "you should",
    });
  });

  it("is stateless across calls (no global-regex lastIndex carry-over)", () => {
    for (let i = 0; i < 3; i++) {
      expect(isNarrationSafe("We recommend rest.")).toBe(false);
      expect(isNarrationSafe("This is not medical advice.")).toBe(true);
    }
  });
});
