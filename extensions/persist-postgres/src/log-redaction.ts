import { createHmac, randomBytes } from "node:crypto";

// Per-process key for log hashes. It is never written anywhere, so a log line cannot be
// matched back to a user even by someone holding a list of Clerk ids. Lines still correlate
// within one gateway process, which is what debugging needs.
const LOG_HASH_KEY = randomBytes(32);

/**
 * Log-safe form of a session key.
 *
 * Session keys embed the caller's identity (for example the verified Clerk user id in
 * `agent:main:openresponses-user:<id>`), so the raw key must not reach log output. A short
 * keyed hash keeps log lines correlatable per session within one process without revealing,
 * or allowing anyone to recompute, who the session belongs to. The database rows still store
 * the real key.
 */
export function sessionKeyForLog(sessionKey: string | undefined | null): string {
  if (!sessionKey) {
    return "session#unknown";
  }
  return `session#${createHmac("sha256", LOG_HASH_KEY).update(sessionKey).digest("hex").slice(0, 12)}`;
}
