/**
 * Format the Syntropy `get_health_profile` result into a compact, labelled
 * `[SYNTROPY_PROFILE]` block for the WhatsApp agent's `before_agent_start`
 * context (SYN-206, Task 1).
 *
 * Allergy/condition-aware and failure-safe: the MCP wrapper may return the
 * health profile, a failure envelope (`{ error }` / `{ type: "paywall" }`), or
 * something defensive (null / non-object / partially-malformed). This function
 * MUST NOT throw for any input — on anything unusable it returns `null` so the
 * caller injects nothing.
 *
 * Output is structured labelled lines (one non-empty field per line), never a
 * raw JSON blob, and every user-controlled value is sanitised so it cannot
 * forge a line boundary or the block markers — free-text prompt-injection
 * hygiene per SYN-170 / OWASP LLM01.
 */

/** Max length of a rendered line's value portion before truncation. */
const VALUE_CAP = 200;
/** Ellipsis appended when a value is truncated (U+2026). */
const ELLIPSIS = "…";

/** Profile-block delimiters — the single source of truth (tests import these; never re-hardcode). */
export const OPEN = "[SYNTROPY_PROFILE]";
export const CLOSE = "[/SYNTROPY_PROFILE]";

/** True for a plain (non-null, non-array) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for code points that must not survive into a rendered value: C0/C1
 * controls, DEL, and Unicode line (U+2028) / paragraph (U+2029) separators —
 * i.e. anything that could introduce a line boundary. */
function isLineBreaking(code: number): boolean {
  return (
    code < 0x20 || // C0 controls incl. CR (0x0D) and LF (0x0A)
    code === 0x7f || // DEL
    (code >= 0x80 && code <= 0x9f) || // C1 controls
    code === 0x2028 || // line separator
    code === 0x2029 // paragraph separator
  );
}

/**
 * Neutralize a user-controlled value before it is rendered into the block.
 * Values are free text the user authored in Syntropy-Journals (allergies,
 * conditions, dietary_preferences, …). Without this, a value containing a
 * newline or a literal `[SYNTROPY_PROFILE]` / `[/SYNTROPY_PROFILE]` marker could
 * forge a line boundary or close the trusted region early — an LLM prompt-
 * injection / boundary-confusion attack (SYN-170, OWASP LLM01).
 *
 * - Replace every line-breaking code point with a space, then collapse runs of
 *   spaces, so no value can introduce a line boundary.
 * - Defang the block markers so they cannot appear inside a value.
 *
 * Linear-time (no backtracking → no ReDoS). Runs BEFORE the length cap so a
 * truncation can never split a marker.
 */
function sanitizeValue(s: string): string {
  let cleaned = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += isLineBreaking(code) ? " " : ch;
  }
  return cleaned
    .replace(/ {2,}/g, " ")
    .split(OPEN)
    .join("(SYNTROPY_PROFILE)")
    .split(CLOSE)
    .join("(/SYNTROPY_PROFILE)");
}

/**
 * Normalize a string-array field: sanitize + trim each item, drop non-string,
 * empty, or whitespace-only items. Non-array input yields no items (empty).
 */
function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const cleaned = sanitizeValue(item).trim();
    if (cleaned.length > 0) out.push(cleaned);
  }
  return out;
}

/**
 * Normalize an object field into `key=value` pairs in input key order: drop
 * entries whose value is null/undefined; render the rest via `String(v)`.
 * Both key and value are sanitized. A value whose `toString`/`valueOf` throws
 * drops just that entry (never propagates). Non-object input → no pairs.
 */
function normalizeObjectPairs(v: unknown): string[] {
  if (!isPlainObject(v)) return [];
  const out: string[] = [];
  for (const key of Object.keys(v)) {
    const value = v[key];
    if (value === null || value === undefined) continue;
    let rendered: string;
    try {
      rendered = String(value);
    } catch {
      continue; // hostile toString/valueOf — drop this entry, keep the field.
    }
    out.push(`${sanitizeValue(key)}=${sanitizeValue(rendered)}`);
  }
  return out;
}

/** Cap a value portion at VALUE_CAP chars, appending the ellipsis when cut. */
function capValue(value: string): string {
  if (value.length <= VALUE_CAP) return value;
  return value.slice(0, VALUE_CAP) + ELLIPSIS;
}

/**
 * Format a health profile into a `[SYNTROPY_PROFILE]` block, or `null` when
 * the caller should inject nothing.
 *
 * Returns `null` when `raw` is not a plain object, is a failure envelope
 * (`"error" in raw` or `raw.type === "paywall"`), or has no usable content
 * after normalization. Otherwise returns a multi-line block whose first line is
 * exactly `[SYNTROPY_PROFILE]` and last line is exactly `[/SYNTROPY_PROFILE]`,
 * with one labelled line per non-empty field in safety-critical order
 * (allergies, conditions, goals, supplements, diet, metrics).
 *
 * Never throws: any unexpected failure (e.g. a hostile throwing getter on a
 * field) collapses to `null` so the caller simply injects no context.
 */
export function formatProfileBlock(raw: unknown): string | null {
  try {
    if (!isPlainObject(raw)) return null;

    // Failure envelopes from the MCP wrapper — never a profile.
    if ("error" in raw) return null;
    if (raw.type === "paywall") return null;

    // Safety-critical field order: allergies and conditions first.
    const lines: string[] = [];

    const allergies = normalizeStringArray(raw.allergies);
    if (allergies.length > 0) lines.push(`allergies: ${capValue(allergies.join(", "))}`);

    const conditions = normalizeStringArray(raw.conditions);
    if (conditions.length > 0) lines.push(`conditions: ${capValue(conditions.join(", "))}`);

    const goals = normalizeStringArray(raw.health_goals);
    if (goals.length > 0) lines.push(`goals: ${capValue(goals.join(", "))}`);

    const supplements = normalizeStringArray(raw.supplement_stack);
    if (supplements.length > 0) lines.push(`supplements: ${capValue(supplements.join(", "))}`);

    const diet = normalizeObjectPairs(raw.dietary_preferences);
    if (diet.length > 0) lines.push(`diet: ${capValue(diet.join(", "))}`);

    const metrics = normalizeObjectPairs(raw.metrics_data);
    if (metrics.length > 0) lines.push(`metrics: ${capValue(metrics.join(", "))}`);

    // No usable content across all six fields → inject nothing.
    if (lines.length === 0) return null;

    return [OPEN, ...lines, CLOSE].join("\n");
  } catch {
    return null;
  }
}
