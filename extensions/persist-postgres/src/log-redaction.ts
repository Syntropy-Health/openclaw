import { createHash } from "node:crypto";

/**
 * Log-safe form of a session key.
 *
 * Session keys embed the caller's identity (for example the verified Clerk user id in
 * `agent:main:openresponses-user:<id>`), so the raw key must not reach log output. A short
 * hash keeps log lines correlatable per session without revealing who the session belongs to.
 * The database rows still store the real key.
 */
export function sessionKeyForLog(sessionKey: string | undefined | null): string {
  if (!sessionKey) {
    return "session#unknown";
  }
  return `session#${createHash("sha256").update(sessionKey).digest("hex").slice(0, 12)}`;
}
