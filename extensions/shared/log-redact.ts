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
