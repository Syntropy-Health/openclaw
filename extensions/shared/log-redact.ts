import { createHmac } from "node:crypto";

/**
 * Log-safe tokens for identifiers that must never reach log storage raw.
 *
 * For SMS and WhatsApp the channel peer id IS the subscriber's E.164 phone
 * number. A plain (unsalted) hash does NOT protect it: the phone-number space
 * is ~10^10 per country code, so sha256(number) is reversed by enumeration in
 * minutes. The token is therefore a KEYED HMAC: stable within a deployment (so
 * log lines still correlate) and not reversible without the key.
 *
 * Key: OPENCLAW_LOG_REDACT_KEY (per deployment, from the secret store). There is
 * deliberately NO built-in fallback key: a default key would be a plain hash
 * again. With no key the token is the literal "redacted" — logs lose
 * correlation but never carry the identifier.
 */
export const LOG_REDACT_KEY_ENV = "OPENCLAW_LOG_REDACT_KEY";

export function logToken(
  value: string | null | undefined,
  key: string | undefined = process.env[LOG_REDACT_KEY_ENV],
): string {
  const v = value?.trim();
  if (!v) {
    return "-";
  }
  const k = key?.trim();
  if (!k) {
    return "redacted";
  }
  return `hmac:${createHmac("sha256", k).update(v).digest("hex").slice(0, 12)}`;
}

/** `channel:<token>` — the channel stays readable, the peer id does not. */
export function redactPeer(channel: string, peerId: string, key?: string): string {
  return `${channel}:${logToken(peerId, key)}`;
}

/**
 * Phone-number shapes scrubbed from every safeErr line (mono #540 review):
 * a WhatsApp jid, a `+`-prefixed number with or without separators, and a bare
 * run of 10–15 digits (US national / unprefixed E.164). Cost: a 13-digit epoch-ms
 * timestamp in an error message is masked too, which is acceptable for a log line.
 */
const PHONE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\d{7,15}@s\.whatsapp\.net/g, "[e164]@s.whatsapp.net"],
  [/\+\d[\d\s().-]{5,20}\d/g, "[e164]"],
  [/(?<![\w.])\d{10,15}(?![\w.])/g, "[e164]"],
];

/**
 * An error rendered for a log line without the identifiers it might echo.
 *
 * Keeps `name: message` (the debugging value) but replaces every caller-known
 * sensitive value (the peer id, a device id) with its {@link logToken}, and any
 * E.164-shaped substring with `[e164]`. Use this instead of `${err}` on any path
 * that handles a peer: a driver or validation error can echo the offending value,
 * and a whole `${err}` would ship it to log storage.
 */
export function safeErr(
  err: unknown,
  sensitive: ReadonlyArray<string | null | undefined> = [],
): string {
  let text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Longest first, so a value that contains another is replaced whole.
  const trimmed = sensitive
    .map((v) => v?.trim())
    .filter((v): v is string => typeof v === "string" && v.length >= 3);
  // Also scrub the digits-only form of a phone-like value (`+1555…` vs `1555…`).
  const digitsOnly = trimmed.map((v) => v.replace(/\D/g, "")).filter((d) => d.length >= 7);
  const values = [...new Set([...trimmed, ...digitsOnly])].sort((a, b) => b.length - a.length);
  for (const v of values) {
    text = text.split(v).join(logToken(v));
  }
  for (const [re, replacement] of PHONE_PATTERNS) {
    text = text.replace(re, replacement);
  }
  return text;
}

/**
 * A peer id for display back to its OWN user in a command reply (mono #543):
 * only the last 4 characters, e.g. "…0123". Never use it for another user's
 * channels: those are not shown at all.
 */
export function maskPeerForDisplay(peerId: string | null | undefined): string {
  const v = (peerId ?? "").trim();
  return v.length > 4 ? `…${v.slice(-4)}` : "…";
}
