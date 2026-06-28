/**
 * Service-auth (M2M) configuration for openclaw → Syntropy Journals `/mcp`.
 *
 * Per the P2 wire contract (cross-app-integration-framework AND.md, D1 + §"P2 —
 * Multi-app authorization"): openclaw mints a genuine Clerk **M2M JWT** carrying
 * a custom **`resource`** claim whose value MUST exactly equal the canonical
 * `/mcp` URI that SJ's token validator checks against. This module resolves, per
 * environment, the two inputs the token provider needs:
 *
 *   1. `machineSecretKey` — the Clerk **machine** secret key (`ak_…`), read from
 *      `CLERK_MACHINE_SECRET_KEY`. NEVER logged (length-only debug is permitted).
 *      Provisioned by devex in Infisical (the persistent openclaw Clerk machine,
 *      test + prod).
 *   2. `resource` — the canonical SJ `/mcp` URI for this environment. This is the
 *      `aud`-equivalent custom claim; Clerk reserves `aud` and overrides it to
 *      `[]`, so the audience binding rides on this custom claim instead. It must
 *      be byte-identical to the URI SJ validates (D1 step 4).
 *
 * Resolution is pure (env injected, not read from `process.env` directly) so the
 * provider is trivially testable. Fail-closed semantics live in the provider
 * (`service-auth.ts`): a *deployed* env (`NODE_ENV=production`) with no machine
 * secret throws rather than emitting an unauthenticated request.
 */

/**
 * The minimal environment shape the service-auth layer depends on. Accepting it
 * as a parameter (rather than reaching into `process.env`) keeps resolution pure
 * and the provider unit-testable without global mutation.
 */
export type ServiceAuthEnv = {
  readonly [key: string]: string | undefined;
} & {
  readonly NODE_ENV?: string;
  /** Clerk machine secret key (`ak_…`) — authenticates the M2M mint call. */
  readonly CLERK_MACHINE_SECRET_KEY?: string;
  /**
   * Optional override for the canonical SJ `/mcp` `resource` URI. When unset,
   * the URI is taken from {@link ServiceAuthConfigInput.resource} (plugin config)
   * which devex wires per environment.
   */
  readonly SYNTROPY_MCP_RESOURCE_URL?: string;
  /** Optional override for the Clerk Backend API base. Defaults to Clerk's BAPI. */
  readonly CLERK_API_URL?: string;
};

/** Default Clerk Backend API origin (BAPI). Overridable via `CLERK_API_URL`. */
export const DEFAULT_CLERK_API_URL = "https://api.clerk.com";

/**
 * Validated service-auth configuration consumed by the token provider.
 */
export interface ServiceAuthConfig {
  /** Clerk machine secret key (`ak_…`). Present iff a secret was configured. */
  readonly machineSecretKey: string | undefined;
  /** Canonical SJ `/mcp` `resource` URI — the value of the M2M `resource` claim. */
  readonly resource: string;
  /** Clerk Backend API base origin (no trailing slash). */
  readonly clerkApiUrl: string;
  /** True when running in a deployed env (`NODE_ENV=production`). */
  readonly isProduction: boolean;
}

/** Plugin-config inputs (from `api.pluginConfig`) relevant to service-auth. */
export interface ServiceAuthConfigInput {
  /**
   * Canonical SJ `/mcp` `resource` URI for this environment. Devex sets this
   * per env (test → SJ test `/mcp`, prod → SJ prod `/mcp`). Required: there is
   * no safe default — a wrong/guessed audience defeats the binding.
   */
  readonly resource?: string;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function isParseableUrl(s: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/** Parse `s` as an `https:` URL, returning the URL or null. (F2) */
function asHttpsUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Discriminates *why* service-auth config resolution failed, so the register-
 * time seam can treat a benign "no machine path configured" (missing resource)
 * differently from a genuine misconfiguration (malformed resource / bad Clerk
 * API URL) that must fail loudly rather than silently disable the path (F11).
 */
export type ServiceAuthConfigErrorReason =
  | "missing-resource"
  | "invalid-resource"
  | "invalid-clerk-api-url";

export class ServiceAuthConfigError extends Error {
  readonly reason: ServiceAuthConfigErrorReason;
  constructor(reason: ServiceAuthConfigErrorReason, message: string) {
    super(message);
    this.name = "ServiceAuthConfigError";
    this.reason = reason;
  }
}

/**
 * Resolve service-auth configuration from plugin config + environment.
 *
 * The `resource` URI is taken from `env.SYNTROPY_MCP_RESOURCE_URL` first (so an
 * env-matrix deploy can set it without editing plugin config), then from
 * `input.resource`. It is **required** and must be a parseable absolute URL —
 * there is no localhost default, because an incorrect audience silently breaks
 * the SJ-side `resource`-claim equality check.
 *
 * The machine secret is read from `env.CLERK_MACHINE_SECRET_KEY` and returned as
 * `undefined` when absent — the provider decides fail-closed vs. dev-soft based
 * on `isProduction`. We never validate the secret's *value* here and never log
 * it.
 *
 * @throws when `resource` is missing or not a parseable URL.
 */
export function resolveServiceAuthConfig(
  input: ServiceAuthConfigInput | undefined | null,
  env: ServiceAuthEnv,
): ServiceAuthConfig {
  const isProduction = env.NODE_ENV === "production";

  const resourceRaw =
    typeof env.SYNTROPY_MCP_RESOURCE_URL === "string" && env.SYNTROPY_MCP_RESOURCE_URL.length > 0
      ? env.SYNTROPY_MCP_RESOURCE_URL
      : typeof input?.resource === "string" && input.resource.length > 0
        ? input.resource
        : undefined;

  if (resourceRaw === undefined) {
    // Benign: the machine path is simply not configured. The register-time seam
    // treats this as "no machine path" (null provider), not a misconfig.
    throw new ServiceAuthConfigError(
      "missing-resource",
      "syntropy service-auth config: missing `resource` — set the canonical " +
        "SJ /mcp URI via pluginConfig.serviceAuthResource or SYNTROPY_MCP_RESOURCE_URL " +
        "(the M2M `resource` claim must equal SJ's validated /mcp URI).",
    );
  }

  if (!isParseableUrl(resourceRaw)) {
    // Misconfig: resource is present but malformed → fail loudly (F11).
    throw new ServiceAuthConfigError(
      "invalid-resource",
      `syntropy service-auth config invalid: \`resource\` must be a parseable URL (got: ${resourceRaw})`,
    );
  }

  // The machine secret (`ak_…`) is POSTed as a Bearer to this URL, so it must be
  // a real https URL — validate it as strictly as `resource` (F2). Default
  // (`api.clerk.com`) is safe; an override must still be https.
  const clerkApiRaw =
    typeof env.CLERK_API_URL === "string" && env.CLERK_API_URL.length > 0
      ? env.CLERK_API_URL
      : DEFAULT_CLERK_API_URL;
  const clerkApiParsed = asHttpsUrl(clerkApiRaw);
  if (!clerkApiParsed) {
    throw new ServiceAuthConfigError(
      "invalid-clerk-api-url",
      `syntropy service-auth config invalid: CLERK_API_URL must be an https URL (got: ${clerkApiRaw}) — ` +
        "the machine secret is sent there as a Bearer; refusing a non-https / unparseable destination.",
    );
  }
  const clerkApiUrl = stripTrailingSlash(clerkApiRaw);

  const machineSecretKey =
    typeof env.CLERK_MACHINE_SECRET_KEY === "string" && env.CLERK_MACHINE_SECRET_KEY.length > 0
      ? env.CLERK_MACHINE_SECRET_KEY
      : undefined;

  return {
    machineSecretKey,
    // Preserve the exact URI SJ validates — do NOT normalize/strip the path.
    resource: resourceRaw,
    clerkApiUrl,
    isProduction,
  };
}
