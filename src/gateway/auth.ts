import type { IncomingMessage } from "node:http";
import type {
  GatewayAuthConfig,
  GatewayTailscaleMode,
  GatewayTrustedProxyConfig,
} from "../config/config.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "./auth-rate-limit.js";
import { verifyClerkJwt, type VerifyClerkJwtOptions } from "./clerk-jwt.js";
import { createClerkSessionResolver } from "./clerk-session-resolver.js";
import {
  type ClerkSessionResolver,
  resolveSessionCacheTtlMs,
  validateClerkSession,
} from "./clerk-session-validation.js";
import {
  isLoopbackAddress,
  isTrustedProxyAddress,
  resolveHostName,
  parseForwardedForClientIp,
  resolveGatewayClientIp,
} from "./net.js";

export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/**
 * Resolved Clerk-JWT verification config for the HTTP chat path. Present only
 * when all three fields are configured; when present, a JWS-shaped bearer on the
 * chat path is verified against the Clerk JWKS and fails closed.
 */
export type ResolvedClerkAuth = {
  jwksUrl: string;
  issuer: string;
  audience: string;
  /**
   * Server-side session validation (A&D §7.4b-A). Present ONLY when the Clerk
   * BACKEND SECRET is configured. When present, a verified clerk-jwt turn is
   * additionally checked against Clerk's live session state (revoked → 401);
   * when ABSENT the turn is JWT-verified only (behavior-preserving for the many
   * gateway deployments that have no revocation requirement). Boot logs which.
   */
  sessionResolver?: ClerkSessionResolver;
  /** Positive-cache TTL for session validation (ms). Config knob. */
  sessionCacheTtlMs?: number;
};

/**
 * Resolved per-`user_scope` τ-meter config for the HTTP chat path (contract §9).
 * Present only when explicitly enabled (config `tau.enabled` or
 * OPENCLAW_TAU_ENABLED); when absent the chat path is unmetered (no-op,
 * behavior-preserving). The numeric fields fall back to the meter's own
 * generous defaults when unset.
 */
export type ResolvedTauConfig = {
  maxCostPerWindow?: number;
  windowMs?: number;
  retryAfterMs?: number;
};

export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
  /** Clerk JWT verification config; present only when fully configured. */
  clerk?: ResolvedClerkAuth;
  /** τ-meter config; present only when explicitly enabled (else unmetered). */
  tau?: ResolvedTauConfig;
};

export type GatewayAuthResult = {
  ok: boolean;
  method?:
    | "none"
    | "token"
    | "password"
    | "tailscale"
    | "device-token"
    | "trusted-proxy"
    | "clerk-jwt";
  user?: string;
  /**
   * Verified cross-channel external id (the Clerk JWT `sub`), present only for a
   * `clerk-jwt`-authenticated request. The chat path derives the server-side
   * `user_scope` from this and NEVER from a client-supplied identity hint.
   */
  externalId?: string;
  reason?: string;
  /** Present when the request was blocked by the rate limiter. */
  rateLimited?: boolean;
  /** Milliseconds the client should wait before retrying (when rate-limited). */
  retryAfterMs?: number;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) {
    return undefined;
  }
  const forwardedFor = headerValue(req.headers?.["x-forwarded-for"]);
  return forwardedFor ? parseForwardedForClientIp(forwardedFor) : undefined;
}

function resolveRequestClientIp(
  req?: IncomingMessage,
  trustedProxies?: string[],
): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    realIp: headerValue(req.headers?.["x-real-ip"]),
    trustedProxies,
  });
}

export function isLocalDirectRequest(req?: IncomingMessage, trustedProxies?: string[]): boolean {
  if (!req) {
    return false;
  }
  const clientIp = resolveRequestClientIp(req, trustedProxies) ?? "";
  if (!isLoopbackAddress(clientIp)) {
    return false;
  }

  const host = resolveHostName(req.headers?.host);
  const hostIsLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const hostIsTailscaleServe = host.endsWith(".ts.net");

  const hasForwarded = Boolean(
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["x-forwarded-host"],
  );

  const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
  return (hostIsLocal || hostIsTailscaleServe) && (!hasForwarded || remoteIsTrustedProxy);
}

function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) {
    return null;
  }
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login.trim()) {
    return null;
  }
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
  return {
    login: login.trim(),
    name,
    profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}

async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  const { req, tailscaleWhois } = params;
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return {
    ok: true,
    user: {
      login: whois.login,
      name: whois.name ?? tailscaleUser.name,
      profilePic: tailscaleUser.profilePic,
    },
  };
}

export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const authConfig = params.authConfig ?? {};
  const env = params.env ?? process.env;
  const token = authConfig.token ?? env.OPENCLAW_GATEWAY_TOKEN ?? undefined;
  const password = authConfig.password ?? env.OPENCLAW_GATEWAY_PASSWORD ?? undefined;
  const trustedProxy = authConfig.trustedProxy;

  let mode: ResolvedGatewayAuth["mode"];
  if (authConfig.mode) {
    mode = authConfig.mode;
  } else if (password) {
    mode = "password";
  } else if (token) {
    mode = "token";
  } else {
    mode = "none";
  }

  const allowTailscale =
    authConfig.allowTailscale ??
    (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");

  const clerk = resolveClerkAuth(authConfig.clerk, env);
  const tau = resolveTauConfig(authConfig.tau, env);

  return {
    mode,
    token,
    password,
    allowTailscale,
    trustedProxy,
    clerk,
    tau,
  };
}

/**
 * Resolve τ-meter config from explicit config falling back to env. Returns a
 * config only when the meter is explicitly enabled (config `tau.enabled === true`
 * or OPENCLAW_TAU_ENABLED is a truthy "1"/"true"); otherwise undefined (meter
 * disabled — chat path unmetered, behavior-preserving). Numeric fields fall back
 * to the meter's own defaults when unset/invalid.
 */
function resolveTauConfig(
  tauConfig: GatewayAuthConfig["tau"],
  env: NodeJS.ProcessEnv,
): ResolvedTauConfig | undefined {
  const envEnabled = /^(1|true)$/i.test((env.OPENCLAW_TAU_ENABLED ?? "").trim());
  const enabled = tauConfig?.enabled ?? envEnabled;
  if (!enabled) {
    return undefined;
  }
  const maxCostPerWindow =
    tauConfig?.maxCostPerWindow ?? parsePositiveIntEnv(env.OPENCLAW_TAU_MAX_COST_PER_WINDOW);
  const windowMs = tauConfig?.windowMs ?? parsePositiveIntEnv(env.OPENCLAW_TAU_WINDOW_MS);
  const retryAfterMs =
    tauConfig?.retryAfterMs ?? parsePositiveIntEnv(env.OPENCLAW_TAU_RETRY_AFTER_MS);
  return { maxCostPerWindow, windowMs, retryAfterMs };
}

/**
 * Parse a positive decimal-integer env value; undefined when unset/blank/invalid.
 * Only plain base-10 digit strings are accepted — scientific (`1e3`), hex
 * (`0x10`), signed (`+5`), and fractional (`1.0`) forms are rejected so a typo'd
 * budget never silently coerces to a surprising number.
 */
function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Resolve Clerk-JWT config from explicit config falling back to env. Returns a
 * fully-populated `ResolvedClerkAuth` only when ALL THREE values are present;
 * otherwise undefined (Clerk verification disabled — legacy path unchanged).
 * Partial config (e.g. JWKS URL but no issuer) is treated as unconfigured.
 */
export function resolveClerkAuth(
  clerkConfig: GatewayAuthConfig["clerk"],
  env: NodeJS.ProcessEnv,
): ResolvedClerkAuth | undefined {
  const jwksUrl = (clerkConfig?.jwksUrl ?? env.OPENCLAW_CLERK_JWKS_URL ?? "").trim();
  const issuer = (clerkConfig?.issuer ?? env.OPENCLAW_CLERK_ISSUER ?? "").trim();
  const audience = (clerkConfig?.audience ?? env.OPENCLAW_CLERK_AUDIENCE ?? "").trim();
  if (!jwksUrl || !issuer || !audience) {
    return undefined;
  }

  // §7.4b-A: server-side session validation activates ONLY when the Clerk BACKEND
  // SECRET is configured. Absent → JWT-verify-only (behavior-preserving). The
  // secret is read here and closed over by the resolver; it is never stored on
  // the returned config object and never logged.
  const secretKey = (clerkConfig?.secretKey ?? env.OPENCLAW_CLERK_SECRET_KEY ?? "").trim();
  let sessionResolver: ClerkSessionResolver | undefined;
  if (secretKey) {
    sessionResolver = createClerkSessionResolver({
      secretKey,
      apiBaseUrl: clerkConfig?.backendApiUrl ?? env.OPENCLAW_CLERK_API_URL,
    });
  }
  const sessionCacheTtlMs = resolveSessionCacheTtlMs(
    { sessionCacheTtlMs: clerkConfig?.sessionCacheTtlMs },
    env,
  );

  return { jwksUrl, issuer, audience, sessionResolver, sessionCacheTtlMs };
}

/**
 * Boot-assert (G-lane [G3], A&D §7 should-fix ii): the three Clerk gateway settings
 * (OPENCLAW_CLERK_JWKS_URL / _ISSUER / _AUDIENCE, or gateway.auth.clerk.*) must be
 * ALL-set or ALL-unset. A PARTIAL config (1 or 2 of 3) silently collapses to
 * "unconfigured" in {@link resolveClerkAuth} → Clerk verification is disabled →
 * the clerk-jwt-mode `shrinemobile` channel net-401s by absence, masking a real
 * operator misconfig. Fail boot LOUDLY instead of silent-disable. Zero-configured
 * (Clerk off) and fully-configured (Clerk on) both pass.
 */
export function assertClerkConfigAllOrNone(
  clerkConfig: GatewayAuthConfig["clerk"],
  env: NodeJS.ProcessEnv,
): void {
  const present = [
    (clerkConfig?.jwksUrl ?? env.OPENCLAW_CLERK_JWKS_URL ?? "").trim(),
    (clerkConfig?.issuer ?? env.OPENCLAW_CLERK_ISSUER ?? "").trim(),
    (clerkConfig?.audience ?? env.OPENCLAW_CLERK_AUDIENCE ?? "").trim(),
  ].filter(Boolean).length;
  if (present !== 0 && present !== 3) {
    throw new Error(
      "Clerk gateway auth is partially configured: set ALL of OPENCLAW_CLERK_JWKS_URL, " +
        "OPENCLAW_CLERK_ISSUER, OPENCLAW_CLERK_AUDIENCE (or gateway.auth.clerk.{jwksUrl,issuer,audience}) " +
        "— or NONE. A partial config silently disables Clerk verification (fail-closed → 401 on the mobile channel).",
    );
  }
}

/**
 * Whether a bearer token is JWS-shaped (exactly three non-empty dot segments).
 * Used to decide if the chat path should attempt Clerk verification — a
 * non-JWS bearer (e.g. the legacy shared secret) is NOT a failed Clerk attempt.
 */
export function looksLikeJws(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Verify a Clerk JWS on the chat path. Fail-closed: any verification failure
 * yields `{ ok: false }`. On success returns the verified `sub` as externalId,
 * plus the Clerk session id (`sid` claim) when present — the revocation handle
 * for the G-lane [G2b] session deny-list.
 */
export async function authorizeClerkJwt(
  token: string,
  clerk: ResolvedClerkAuth,
  options?: Pick<VerifyClerkJwtOptions, "now" | "fetchJwks">,
): Promise<{ ok: true; externalId: string; sid?: string } | { ok: false }> {
  const verified = await verifyClerkJwt(token, {
    jwksUrl: clerk.jwksUrl,
    issuer: clerk.issuer,
    audience: clerk.audience,
    now: options?.now,
    fetchJwks: options?.fetchJwks,
  });
  if (!verified) {
    return { ok: false };
  }
  const sid = typeof verified.claims.sid === "string" ? verified.claims.sid : undefined;
  return { ok: true, externalId: verified.sub, sid };
}

export function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  if (auth.mode === "password" && !auth.password) {
    throw new Error("gateway auth mode is password, but no password was configured");
  }
  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      throw new Error(
        "gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)",
      );
    }
    if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") {
      throw new Error(
        "gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)",
      );
    }
  }
}

/**
 * Check if the request came from a trusted proxy and extract user identity.
 * Returns the user identity if valid, or null with a reason if not.
 */
function authorizeTrustedProxy(params: {
  req?: IncomingMessage;
  trustedProxies?: string[];
  trustedProxyConfig: GatewayTrustedProxyConfig;
}): { user: string } | { reason: string } {
  const { req, trustedProxies, trustedProxyConfig } = params;

  if (!req) {
    return { reason: "trusted_proxy_no_request" };
  }

  const remoteAddr = req.socket?.remoteAddress;
  if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) {
    return { reason: "trusted_proxy_untrusted_source" };
  }

  const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
  for (const header of requiredHeaders) {
    const value = headerValue(req.headers[header.toLowerCase()]);
    if (!value || value.trim() === "") {
      return { reason: `trusted_proxy_missing_header_${header}` };
    }
  }

  const userHeaderValue = headerValue(req.headers[trustedProxyConfig.userHeader.toLowerCase()]);
  if (!userHeaderValue || userHeaderValue.trim() === "") {
    return { reason: "trusted_proxy_user_missing" };
  }

  const user = userHeaderValue.trim();

  const allowUsers = trustedProxyConfig.allowUsers ?? [];
  if (allowUsers.length > 0 && !allowUsers.includes(user)) {
    return { reason: "trusted_proxy_user_not_allowed" };
  }

  return { user };
}

export async function authorizeGatewayConnect(params: {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
  /** Optional rate limiter instance; when provided, failed attempts are tracked per IP. */
  rateLimiter?: AuthRateLimiter;
  /** Client IP used for rate-limit tracking. Falls back to proxy-aware request IP resolution. */
  clientIp?: string;
  /** Optional limiter scope; defaults to shared-secret auth scope. */
  rateLimitScope?: string;
  /** Injectable JWKS fetcher for Clerk verification (tests); real fetch by default. */
  fetchClerkJwks?: VerifyClerkJwtOptions["fetchJwks"];
  /** Logger for §7.4b-A session validation (fail-open ERROR etc.). */
  sessionLogger?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
  };
  /** Metric sink for the fail-open alarm. */
  sessionMetric?: (name: string) => void;
}): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const localDirect = isLocalDirectRequest(req, trustedProxies);

  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      return { ok: false, reason: "trusted_proxy_config_missing" };
    }
    if (!trustedProxies || trustedProxies.length === 0) {
      return { ok: false, reason: "trusted_proxy_no_proxies_configured" };
    }

    const result = authorizeTrustedProxy({
      req,
      trustedProxies,
      trustedProxyConfig: auth.trustedProxy,
    });

    if ("user" in result) {
      return { ok: true, method: "trusted-proxy", user: result.user };
    }
    return { ok: false, reason: result.reason };
  }

  const limiter = params.rateLimiter;
  const ip =
    params.clientIp ?? resolveRequestClientIp(req, trustedProxies) ?? req?.socket?.remoteAddress;
  const rateLimitScope = params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET;
  if (limiter) {
    const rlCheck: RateLimitCheckResult = limiter.check(ip, rateLimitScope);
    if (!rlCheck.allowed) {
      return {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: rlCheck.retryAfterMs,
      };
    }
  }

  // --- Clerk JWT (chat path). When Clerk is configured AND the presented
  // bearer is JWS-shaped, this request is a Clerk-authenticated chat request and
  // MUST be verified by Clerk — it never falls through to the legacy shared
  // token/password comparison. A JWS-shaped bearer that fails verification is a
  // failed auth attempt (rate-limited) and returns unauthorized (fail-closed).
  // A non-JWS bearer is left to the legacy paths below (back-compat). ---
  if (auth.clerk && connectAuth?.token && looksLikeJws(connectAuth.token)) {
    const clerkResult = await authorizeClerkJwt(connectAuth.token, auth.clerk, {
      fetchJwks: params.fetchClerkJwks,
    });
    if (clerkResult.ok) {
      // G-lane [G2b] §7.4b-A: server-side Clerk session validation. Active ONLY
      // when a session resolver is configured (the Clerk backend secret is set);
      // when absent, JWT-verify-only (behavior-preserving for deployments with no
      // revocation requirement — boot logs which mode). The session id is the
      // X-OpenClaw-Clerk-Session-Id header — a LOOKUP KEY, never an assertion: we
      // resolve it against Clerk and trust the RESOLUTION (+ sub-match), never the
      // header. Revoked/not-found/no-handle/sub-mismatch → 401; Clerk-unreachable →
      // fail-open (ratified). This is what survives token RE-MINTING, which the
      // withdrawn jti/sid deny-lists could not.
      if (auth.clerk.sessionResolver) {
        const sessionId = headerValue(req?.headers?.["x-openclaw-clerk-session-id"]);
        const decision = await validateClerkSession({
          sub: clerkResult.externalId,
          sessionId,
          resolve: auth.clerk.sessionResolver,
          cacheTtlMs: auth.clerk.sessionCacheTtlMs,
          now: Date.now(),
          logger: params.sessionLogger,
          metric: params.sessionMetric,
        });
        if (!decision.ok) {
          limiter?.recordFailure(ip, rateLimitScope);
          return { ok: false, reason: `clerk_session_${decision.reason.replace(/-/g, "_")}` };
        }
      }
      limiter?.reset(ip, rateLimitScope);
      return { ok: true, method: "clerk-jwt", externalId: clerkResult.externalId };
    }
    limiter?.recordFailure(ip, rateLimitScope);
    return { ok: false, reason: "clerk_jwt_invalid" };
  }

  if (auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      limiter?.reset(ip, rateLimitScope);
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
  }

  if (auth.mode === "token") {
    if (!auth.token) {
      return { ok: false, reason: "token_missing_config" };
    }
    if (!connectAuth?.token) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "token_missing" };
    }
    if (!safeEqualSecret(connectAuth.token, auth.token)) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "token_mismatch" };
    }
    limiter?.reset(ip, rateLimitScope);
    return { ok: true, method: "token" };
  }

  if (auth.mode === "password") {
    const password = connectAuth?.password;
    if (!auth.password) {
      return { ok: false, reason: "password_missing_config" };
    }
    if (!password) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "password_missing" };
    }
    if (!safeEqualSecret(password, auth.password)) {
      limiter?.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "password_mismatch" };
    }
    limiter?.reset(ip, rateLimitScope);
    return { ok: true, method: "password" };
  }

  limiter?.recordFailure(ip, rateLimitScope);
  return { ok: false, reason: "unauthorized" };
}
