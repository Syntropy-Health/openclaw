/**
 * Voice mapping and XML utilities for voice call providers.
 */

/**
 * Escape XML special characters for TwiML and other XML responses.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Map of OpenAI voice names to similar Twilio Polly voices.
 */
const OPENAI_TO_POLLY_MAP: Record<string, string> = {
  alloy: "Polly.Joanna", // neutral, warm
  echo: "Polly.Matthew", // male, warm
  fable: "Polly.Amy", // British, expressive
  onyx: "Polly.Brian", // deep male
  nova: "Polly.Salli", // female, friendly
  shimmer: "Polly.Kimberly", // female, clear
};

/**
 * Default Polly voice when no mapping is found.
 */
export const DEFAULT_POLLY_VOICE = "Polly.Joanna";

/**
 * Map OpenAI voice names to Twilio Polly equivalents.
 * Falls through if already a valid Polly/Google voice.
 *
 * @param voice - OpenAI voice name (alloy, echo, etc.) or Polly voice name
 * @returns Polly voice name suitable for Twilio TwiML
 */
/**
 * Grammar for a provider voice TOKEN (`Polly.Joanna`, `Google.en-US-Neural2-A`).
 * Validation-not-escaping (#217): the value lands RAW inside
 * `<Say voice="...">` at BOTH live call sites, so the pass-through branch must
 * admit only token-shaped strings. Amazon/Google voice CATALOGS drift, so the
 * allow-list is the token grammar, not an enumeration — anything XML-active
 * (quotes, angle brackets, spaces) is outside [A-Za-z0-9.-] and fails.
 */
const PROVIDER_VOICE_RE = /^(Polly|Google)\.[A-Za-z0-9.-]{1,64}$/;

export function mapVoiceToPolly(voice: string | undefined): string {
  if (!voice) {
    return DEFAULT_POLLY_VOICE;
  }

  // Provider-voice pass-through — VALIDATED, not verbatim (#217). The old
  // branch returned any `Polly.`/`Google.`-prefixed string unchanged, which
  // made "config-derived therefore bounded" reasoning load-bearing at two
  // call sites that interpolate the result raw into a TwiML attribute. The
  // token grammar closes injection at this choke point for BOTH callers.
  if (voice.startsWith("Polly.") || voice.startsWith("Google.")) {
    if (PROVIDER_VOICE_RE.test(voice)) {
      return voice;
    }
    // FAIL CLOSED to the default voice rather than throwing: this runs on a
    // LIVE CALL, and the function's existing contract already degrades
    // unknown OpenAI names to the default — a malformed provider token gets
    // the same resilience, minus the injection. The log names the shape
    // safely (JSON-escaped, capped), never echoing raw content.
    console.warn(
      `[voice-call] rejected malformed provider voice ${JSON.stringify(voice.slice(0, 64))} — ` +
        `not a valid Polly./Google. token; using ${DEFAULT_POLLY_VOICE} (#217)`,
    );
    return DEFAULT_POLLY_VOICE;
  }

  // Map OpenAI voices to Polly equivalents
  return OPENAI_TO_POLLY_MAP[voice.toLowerCase()] || DEFAULT_POLLY_VOICE;
}

/**
 * Check if a voice name is a known OpenAI voice.
 */
export function isOpenAiVoice(voice: string): boolean {
  return voice.toLowerCase() in OPENAI_TO_POLLY_MAP;
}

/**
 * Get all supported OpenAI voice names.
 */
export function getOpenAiVoiceNames(): string[] {
  return Object.keys(OPENAI_TO_POLLY_MAP);
}
