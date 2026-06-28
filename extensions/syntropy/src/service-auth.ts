/**
 * Service-auth token provider — openclaw → Syntropy Journals `/mcp` (M2M).
 *
 * This is the auth layer for **machine-to-machine** (service) calls from openclaw
 * to SJ's `/mcp`, distinct from the per-user `sj_*` Bearer path in `client.ts`
 * (which SJ routes via its `sj_`-prefix → Unkey path, unchanged). Per the P2 wire
 * contract (cross-app-integration-framework AND.md, §"P2 — Multi-app
 * authorization"):
 *
 *   - openclaw holds `CLERK_MACHINE_SECRET_KEY` (Infisical; devex-provisioned).
 *   - It mints a genuine Clerk **M2M JWT**:
 *       createToken({ tokenFormat: 'jwt', claims: { resource: <SJ /mcp URI> } })
 *     — Clerk's closest analogue to a client-credentials grant. Clerk reserves
 *     `aud` (overrides → `[]`), so the audience binding rides on the custom
 *     **`resource`** claim instead.
 *   - The minted JWT is RS256-signed by Clerk, carries the openclaw machine id as
 *     `sub`, and is verifiable via Clerk's JWKS. SJ authorizes ONLY openclaw's
 *     `sub` (allow-list) AND `resource` == its canonical `/mcp` URI.
 *   - openclaw attaches `Authorization: Bearer <token>` to its outbound `/mcp`
 *     request (see {@link withServiceAuthBearer} / `ServiceAuthProvider.buildAuthHeaders`).
 *
 * **Fail-closed:** in a deployed env (`NODE_ENV=production`) a missing machine
 * secret throws — we never emit an unauthenticated `/mcp` request. In dev the
 * same condition throws too (there is no safe "anonymous" fallback for an
 * authenticated machine path), but the error is explicit so local setups know to
 * provide the secret.
 *
 * **Caching / refresh:** the minted JWT is cached and reused until a refresh
 * skew window before its `exp`, then re-minted. Mint is single-flighted so
 * concurrent callers share one in-flight mint rather than stampeding Clerk.
 *
 * The Clerk mint is done via the documented Backend API endpoint
 * (`POST /v1/m2m_tokens`) over `fetch` — the same transport style as
 * `client.ts` — so no heavy SDK dependency is added. The HTTP surface is
 * abstracted behind {@link MintFn} so a future swap to `@clerk/backend`'s
 * `clerkClient.m2m.createToken()` (or the deferred client-credentials AS shim)
 * is a one-line injection with no change to callers.
 */

import type { ServiceAuthConfig } from "./service-auth-config.js";

/** Clerk Backend API version segment for the M2M endpoint. */
const CLERK_BAPI_VERSION = "v1";

/**
 * Default seconds-until-expiration requested when minting. Clerk defaults M2M
 * tokens to non-expiring (`null`); for a service token we want a bounded
 * lifetime so a leaked token is short-lived and refresh stays exercised.
 */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600; // 1h

/**
 * Refresh the cached token when it is within this many seconds of `exp`. Guards
 * against clock skew and in-flight request latency racing the boundary.
 */
export const DEFAULT_REFRESH_SKEW_SECONDS = 60;

/** A minted service token + its absolute expiry (epoch ms). */
export interface MintedToken {
  /** The RS256 Clerk M2M JWT string (the Bearer value). */
  readonly token: string;
  /** Absolute expiry, epoch milliseconds. */
  readonly expiresAtMs: number;
}

/**
 * The mint primitive: given the resolved config, return a freshly-minted token.
 * Injectable so tests (and a future SDK/shim swap) don't touch the network.
 */
export type MintFn = (cfg: ServiceAuthConfig) => Promise<MintedToken>;

/** Monotonic-ish clock injection point (epoch ms). Defaults to `Date.now`. */
export type NowFn = () => number;

export interface ServiceAuthProviderOptions {
  /** Override the mint primitive (default: Clerk BAPI over fetch). */
  readonly mint?: MintFn;
  /** Override the clock (default: `Date.now`). */
  readonly now?: NowFn;
  /** Seconds before `exp` at which the cached token is refreshed. */
  readonly refreshSkewSeconds?: number;
}

/**
 * Shape of the Clerk `POST /v1/m2m_tokens` response we consume. Clerk returns
 * additional fields (`id`, `subject`, `scopes`, …) we deliberately ignore here —
 * `sub`/RS256/`iss` are validated SJ-side, not re-parsed by the minter.
 */
interface ClerkM2MTokenResponse {
  /** The token string (opaque or JWT depending on `token_format`). */
  token?: string;
  /** Expiry. Clerk returns a unix-seconds timestamp (or null = non-expiring). */
  expiration?: number | null;
}

/**
 * Mint a Clerk M2M JWT via the Backend API (`POST /v1/m2m_tokens`).
 *
 * Authenticated with the **machine secret key** (`ak_…`) as a Bearer credential.
 * Faithful to `createToken({ tokenFormat: 'jwt', claims: { resource } })`:
 * the REST body uses snake_case (`token_format`, `seconds_until_expiration`).
 *
 * The machine secret is sent only in the `Authorization` header of this call and
 * is NEVER logged or returned.
 *
 * @throws when no machine secret is configured (caller is expected to gate on
 *         fail-closed first, but this is a hard guard), or on a non-2xx / missing
 *         token response.
 */
export const clerkBapiMint: MintFn = async (cfg) => {
  if (!cfg.machineSecretKey) {
    // Defense-in-depth: the provider gates fail-closed before calling mint, but
    // never let a mint proceed without a credential.
    throw new Error("syntropy service-auth: cannot mint — machine secret key absent");
  }

  const url = `${cfg.clerkApiUrl}/${CLERK_BAPI_VERSION}/m2m_tokens`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.machineSecretKey}`,
    },
    body: JSON.stringify({
      token_format: "jwt",
      seconds_until_expiration: DEFAULT_TOKEN_TTL_SECONDS,
      // The audience-equivalent custom claim. Byte-identical to SJ's /mcp URI.
      claims: { resource: cfg.resource },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // Surface status + body but NEVER the request credential.
    throw new Error(`syntropy service-auth: Clerk mint failed (${resp.status}): ${text}`);
  }

  const json = (await resp.json().catch(() => ({}))) as ClerkM2MTokenResponse;
  if (typeof json.token !== "string" || json.token.length === 0) {
    throw new Error("syntropy service-auth: Clerk mint returned no token");
  }

  // Clerk returns `expiration` as unix SECONDS (or null for non-expiring). We
  // requested a bounded TTL, so derive a concrete expiry; fall back to the
  // requested TTL when the field is absent/null so the cache always refreshes.
  const nowMs = Date.now();
  const fallbackExpiresAtMs = nowMs + DEFAULT_TOKEN_TTL_SECONDS * 1000;
  const claimedExpiresAtMs =
    typeof json.expiration === "number" && Number.isFinite(json.expiration)
      ? json.expiration * 1000
      : undefined;

  // Lower-bound clamp (F3): a missing/null OR already-past/near-now expiration
  // would make the cache treat the token as permanently stale → a re-mint on
  // every getToken (single-flight only dedups *concurrent* calls). Reject a
  // non-positive remaining lifetime and fall back to the requested TTL so the
  // cache + refresh-skew logic always has a sane future expiry to work with.
  const expiresAtMs =
    claimedExpiresAtMs !== undefined && claimedExpiresAtMs > nowMs
      ? claimedExpiresAtMs
      : fallbackExpiresAtMs;

  return { token: json.token, expiresAtMs };
};

/**
 * A reusable service-auth token provider: caches the minted M2M JWT, refreshes
 * it before `exp`, single-flights concurrent mints, and fails closed when no
 * machine secret is configured.
 *
 * Construct one per `(config)` and share it across the openclaw → SJ `/mcp` call
 * sites. The P1 matrix client and openclaw's eventual MCP-tool consumption of SJ
 * `/mcp` drop in via {@link getToken} / {@link buildAuthHeaders}.
 */
export class ServiceAuthProvider {
  private readonly cfg: ServiceAuthConfig;
  private readonly mint: MintFn;
  private readonly now: NowFn;
  private readonly refreshSkewMs: number;

  private cached: MintedToken | null = null;
  private inFlight: Promise<MintedToken> | null = null;
  // Monotonic generation: bumped by invalidate(). A mint that was dispatched
  // under an older generation must NOT repopulate `cached` (F1) — otherwise an
  // invalidate() racing an in-flight mint (the post-401 case) would resurrect
  // the just-invalidated token when the stale mint resolves.
  private generation = 0;

  constructor(cfg: ServiceAuthConfig, opts: ServiceAuthProviderOptions = {}) {
    this.cfg = cfg;
    this.mint = opts.mint ?? clerkBapiMint;
    this.now = opts.now ?? Date.now;
    this.refreshSkewMs = (opts.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;
  }

  /** True when no machine secret is configured. */
  get secretMissing(): boolean {
    return !this.cfg.machineSecretKey;
  }

  private isFresh(t: MintedToken | null): t is MintedToken {
    if (!t) return false;
    return this.now() < t.expiresAtMs - this.refreshSkewMs;
  }

  /**
   * Return a valid Bearer token, minting/refreshing as needed.
   *
   * **Fail-closed:** if no machine secret is configured this throws — both in a
   * deployed env and in dev — rather than returning an empty/anonymous token.
   * Callers must surface (not swallow) this so an unauthenticated `/mcp` request
   * is never emitted.
   */
  async getToken(): Promise<string> {
    if (this.secretMissing) {
      const where = this.cfg.isProduction ? "production" : "non-production";
      throw new Error(
        `syntropy service-auth: CLERK_MACHINE_SECRET_KEY is missing (${where}) — ` +
          "refusing to issue an unauthenticated openclaw → SJ /mcp request (fail-closed).",
      );
    }

    if (this.isFresh(this.cached)) return this.cached.token;

    // Single-flight: concurrent callers that all miss the cache share one mint.
    if (!this.inFlight) {
      const mintGen = this.generation;
      this.inFlight = this.mint(this.cfg)
        .then((minted) => {
          // Only cache if no invalidate() bumped the generation while this mint
          // was in flight (F1). A stale mint still resolves its own awaiters
          // (they asked before the invalidate), but it must not overwrite the
          // cache for the next caller, which expects a guaranteed-fresh mint.
          if (mintGen === this.generation) this.cached = minted;
          return minted;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    const minted = await this.inFlight;
    return minted.token;
  }

  /**
   * Build the outbound headers for an openclaw → SJ `/mcp` request, including the
   * `Authorization: Bearer <M2M JWT>` and any caller-supplied base headers.
   */
  async buildAuthHeaders(base?: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { ...(base ?? {}), Authorization: `Bearer ${token}` };
  }

  /**
   * Force the next {@link getToken} to re-mint (e.g. after a 401).
   *
   * Bumps the generation so any mint already in flight cannot repopulate the
   * cache when it resolves (F1) — the next getToken sees no cache and starts a
   * fresh mint. A mint in flight is not aborted; its existing awaiters still
   * receive its result, but it is excluded from the cache.
   */
  invalidate(): void {
    this.cached = null;
    this.generation += 1;
  }
}

/**
 * Convenience: attach the service-auth Bearer to a header bag using a provider.
 * The documented seam where the future MCP client / P1 matrix client wires the
 * M2M auth onto its outbound SJ `/mcp` request.
 */
export async function withServiceAuthBearer(
  provider: ServiceAuthProvider,
  base?: Record<string, string>,
): Promise<Record<string, string>> {
  return provider.buildAuthHeaders(base);
}
