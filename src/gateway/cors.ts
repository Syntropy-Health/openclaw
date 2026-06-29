/**
 * CORS for the gateway HTTP API endpoints (`/v1/responses`,
 * `/v1/chat/completions`).
 *
 * Browser clients (Flutter web preview, browser integration tests) need CORS to
 * call the chat API cross-origin; native mobile apps do NOT (CORS is a browser
 * mechanism). Best-practice posture:
 *  - Exact-match allowlist (config `gateway.http.cors.allowedOrigins` or env
 *    `OPENCLAW_HTTP_CORS_ORIGINS`, comma-separated). No headers emitted when the
 *    allowlist is empty (default) — opt-in only.
 *  - Echo the matched Origin (never a blanket `*` unless explicitly configured),
 *    with `Vary: Origin` so caches don't cross-contaminate.
 *  - `"*"` is supported as an explicit, trusted dev/test opt-in: it echoes the
 *    request Origin (so `Authorization: Bearer` still works — `*` literal forbids
 *    credentials/auth in some stacks; echoing the origin is safer + equivalent).
 *  - Preflight (OPTIONS) → 204 with allowed methods/headers + Max-Age.
 *
 * Auth is unchanged: CORS only controls which browser origins may READ the
 * response; the Bearer token / Clerk-JWT gate still authorizes every request.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_METHODS = "POST, OPTIONS";
// The contract's request headers (chat-endpoint-contract §2) + auth/content.
const ALLOWED_HEADERS =
  "authorization, content-type, x-openclaw-session-key, x-openclaw-device-id, x-openclaw-agent-id, idempotency-key";
const MAX_AGE_SECONDS = "600";

/**
 * Resolve the CORS allowlist from config + env (union). Env
 * `OPENCLAW_HTTP_CORS_ORIGINS` is comma-separated. Trailing slashes are trimmed
 * so "http://x/" and "http://x" match.
 */
export function resolveCorsAllowedOrigins(params: {
  configOrigins?: string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  const fromEnv = (params.env?.OPENCLAW_HTTP_CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const fromConfig = (params.configOrigins ?? []).map((o) => o.trim()).filter(Boolean);
  const normalized = [...fromConfig, ...fromEnv].map((o) =>
    o === "*" ? "*" : o.replace(/\/+$/, ""),
  );
  return Array.from(new Set(normalized));
}

/** Returns the Origin value to echo in Access-Control-Allow-Origin, or null. */
export function resolveAllowedOrigin(
  originHeader: string | undefined,
  allowlist: string[],
): string | null {
  const origin = originHeader?.trim();
  if (!origin || allowlist.length === 0) {
    return null;
  }
  if (allowlist.includes("*")) {
    return origin;
  }
  return allowlist.includes(origin.replace(/\/+$/, "")) ? origin : null;
}

export type CorsOutcome = { preflight: boolean };

/**
 * Apply CORS headers for the API endpoints. If the request Origin is allowed,
 * sets the Access-Control-* headers (echoing the origin). Returns
 * `{ preflight: true }` when the request is an OPTIONS preflight the caller
 * should terminate with 204.
 */
export function applyApiCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowlist: string[],
): CorsOutcome {
  const isOptions = (req.method ?? "").toUpperCase() === "OPTIONS";
  const allowed = resolveAllowedOrigin(req.headers.origin, allowlist);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);
  }
  return { preflight: isOptions };
}

/** Terminate a CORS preflight (call only after applyApiCors). */
export function endPreflight(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}
