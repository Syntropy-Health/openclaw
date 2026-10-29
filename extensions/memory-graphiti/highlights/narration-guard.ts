/**
 * Narration guard (A&D §4.5): a port of SJ's `assert_narration_safe`.
 *
 * Every highlight title and body passes here before it is cached or served. A
 * failing entry is dropped, never rewritten. The rules are SJ's, unchanged:
 *   - the efficacy and advice lexicons, matched as word stems;
 *   - the imperative-dose structural check ("take 500 mg");
 *   - negated disclaimers ("not intended to diagnose, treat…", "not medical
 *     advice") are cut out before the scan, and the cut stops at the disclaimer
 *     word, so a clause smuggled after it is still scanned;
 *   - the same folding (casefold, confusable letters, NFKC, zero-width and
 *     combining marks removed).
 *
 * Python's `\b`, `\w` and `\d` are Unicode-aware; JS's are ASCII-only, so the
 * port spells them as Unicode classes. Python's casefold is approximated by
 * toLowerCase plus the casefold-only mappings that matter here (ß, ẞ, ς); NFKC
 * covers ligatures and compatibility forms in both.
 *
 * Parity is held by narration-guard.fixtures.json, which SJ runs against the
 * Python guard as well. Change the rules only together with SJ.
 */

/** The SJ source this ports (git blob of claims.py) and its guard version. */
export const NARRATION_GUARD_SOURCE = Object.freeze({
  repo: "Syntropy-Health/SyntropyJournal",
  path: "LHM/syntropy/lhm/metrics/claims.py",
  blob: "c74a53da3",
  guardVersion: "claims-v3",
});

/** Clinical-efficacy vocabulary (SJ BANNED_LEXICON). */
export const BANNED_LEXICON: readonly string[] = Object.freeze([
  "improve",
  "treat",
  "cure",
  "prevent",
  "reverse",
  "efficacy",
  "clinical",
]);

/** Advice and diagnosis framing (SJ BANNED_ADVICE_LEXICON). "consult" is allowed on purpose. */
export const BANNED_ADVICE_LEXICON: readonly string[] = Object.freeze([
  "recommend",
  "diagnos",
  "prescrib",
  "advis",
  "advice",
  "should take",
  "you should",
  "at risk",
]);

/** Python's Unicode `\w`. */
const W = String.raw`[\p{L}\p{N}_]`;
/** Python's `\b` where the next character is a word character. */
const START = `(?<!${W})`;
/** Python's `\b` where the previous character is a word character. */
const END = `(?!${W})`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// No `g` flag on the test-only patterns: a global regex keeps lastIndex
// between calls, which would make the guard stateful.
const BANNED_RE = new RegExp(
  `${START}(${[...BANNED_LEXICON, ...BANNED_ADVICE_LEXICON].map(escapeRe).join("|")})${W}*`,
  "iu",
);

const FDA_NEGATED_VERBS = "(?:diagnose|treat|cure|prevent|mitigate)";
const DISCLAIMER_RE = new RegExp(
  "(?:" +
    String.raw`not\s+(?:intended|meant)\s+to\s+[^.;,:()—–-]*?` +
    FDA_NEGATED_VERBS +
    String.raw`(?:(?:\s*,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+)` +
    FDA_NEGATED_VERBS +
    ")*" +
    String.raw`|not\s+(?:a\s+|an\s+)?(?:medical\s+|clinical\s+)?` +
    "(?:recommendation|advice|diagnosis|prescription)" +
    ")",
  "giu",
);

const IMPERATIVE_DOSE_RE = new RegExp(
  `${START}(?:take|takes|taking|start|starts|starting|stop|stops|stopping)${END}` +
    "[^.;:!?]{0,80}?" +
    String.raw`${START}\p{Nd}+(?:\.\p{Nd}+)?\s?(?:mg|mcg|g|iu|ml)${END}`,
  "iu",
);

/** SJ _CONFUSABLE_FOLD: Cyrillic and Greek lowercase lookalikes to Latin. */
const CONFUSABLE_FOLD: Readonly<Record<string, string>> = Object.freeze({
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ѕ: "s",
  і: "i",
  ј: "j",
  һ: "h",
  ԛ: "q",
  ԝ: "w",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ϲ: "c",
});

const translate = (s: string): string => {
  let out = "";
  for (const ch of s) {
    out += CONFUSABLE_FOLD[ch] ?? ch;
  }
  return out;
};

const casefold = (s: string): string =>
  s.toLowerCase().replace(/ß/g, "ss").replace(/ẞ/g, "ss").replace(/ς/g, "σ");

/** SJ _fold: casefold + confusables, NFKC, drop Cf/Mn, then casefold + confusables again. */
export function foldForGuard(text: string): string {
  const prefolded = translate(casefold(text));
  const stripped = prefolded.normalize("NFKC").replace(/[\p{Cf}\p{Mn}]/gu, "");
  return translate(casefold(stripped));
}

export type NarrationCheck =
  | { ok: true }
  | { ok: false; kind: "banned_term" | "imperative_dose"; term: string };

/**
 * Check one piece of model narration. `term` is the matched text, for tests and
 * debugging; log the `kind` only, since a dose match can carry user detail.
 */
export function checkNarration(text: string): NarrationCheck {
  const stripped = foldForGuard(text).replace(DISCLAIMER_RE, "");
  const banned = BANNED_RE.exec(stripped);
  if (banned) {
    return { ok: false, kind: "banned_term", term: banned[0] };
  }
  const dose = IMPERATIVE_DOSE_RE.exec(stripped);
  if (dose) {
    return { ok: false, kind: "imperative_dose", term: dose[0] };
  }
  return { ok: true };
}

export function isNarrationSafe(text: string): boolean {
  return checkNarration(text).ok;
}
