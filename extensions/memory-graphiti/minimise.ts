/**
 * Data minimisation for memory ingest (CTO #16917 item 4).
 *
 * A transcript user turn is `${prependContext}\n\n${prompt}` (attempt.ts): plugin
 * context blocks — identity, scope, gates, the health profile, recalled facts —
 * are glued onto what the person actually typed. Memory needs only the
 * conversation, so those blocks are stripped BEFORE anything leaves for the
 * memory store, and any Clerk user id left in free text is redacted.
 *
 * Fail closed: if a known block opener survives stripping (an unrecognised
 * shape), the message is NOT ingested (returns null). No ingest means no
 * receipt, so the transcript is held and the retention alert fires — visible,
 * never a silent leak.
 */

/** `<graphiti-facts> … </graphiti-facts>` recalled-memory block. */
const FACTS_BLOCK = /<graphiti-facts>[\s\S]*?<\/graphiti-facts>/g;

/**
 * Openers of blocks that are emitted WITHOUT a closing tag. Each is a single
 * paragraph, so it runs to the next blank line (or the end of the text).
 */
const UNPAIRED_OPENERS = ["SMS_SAFETY", "SYNTROPY_MCP", "MEMORY_SCOPE"];
const UNPAIRED_BLOCK = new RegExp(
  `\\[(?:${UNPAIRED_OPENERS.join("|")})\\][^\\n]*(?:\\n(?!\\n)[^\\n]*)*`,
  "g",
);

/** Every context-block tag we know of; one surviving after the strip ⇒ fail closed. */
const KNOWN_TAGS = [
  "USER_IDENTITY",
  "MEMORY_SCOPE",
  "IDENTITY_GATE",
  "SYNTROPY_GATE",
  "SYNTROPY_PROFILE",
  "SYNTROPY_MCP",
  "SMS_SAFETY",
  "CATCH_PHRASE_MATCH",
];
const SURVIVING_TAG = new RegExp(`\\[\\/?(?:${KNOWN_TAGS.join("|")})\\]|<\\/?graphiti-facts>`);

/**
 * Known `[NAME] … [/NAME]` context blocks only. A user's own bracketed text
 * (e.g. "[NOTE] call Dr X [/NOTE]") is NOT a context block and is kept.
 */
const PAIRED_BLOCK = new RegExp(`\\[(${KNOWN_TAGS.join("|")})\\][\\s\\S]*?\\[\\/\\1\\]`, "g");

/** A Clerk user id (`user_` + 20+ base62 chars). */
const CLERK_ID = /\buser_[A-Za-z0-9]{20,}\b/g;

/** Identity key/value lines that can appear outside a block. */
const IDENTITY_LINE = /^\s*(?:external_id|user_id|scope_key|clerk_id)\s*:.*$/gim;

export const REDACTED_ID = "[id]";

/**
 * The memory-safe text for one message, or `null` when it must not be ingested
 * (empty after minimisation, or an unrecognised context block survived).
 */
export function minimiseForMemory(text: string): string | null {
  let out = text
    .replace(FACTS_BLOCK, "")
    .replace(PAIRED_BLOCK, "")
    .replace(UNPAIRED_BLOCK, "")
    .replace(IDENTITY_LINE, "")
    .replace(CLERK_ID, REDACTED_ID);
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  if (SURVIVING_TAG.test(out)) {
    return null;
  }
  return out.length > 0 ? out : null;
}
