/**
 * Syntropy plugin configuration — validated at register() time.
 *
 * Replaces ad-hoc `(api.pluginConfig?.foo as string | undefined) ?? "default"`
 * parsing with explicit dependency injection (PR #9 review follow-up, Item 3):
 *
 *   - `syntropyBaseUrl` is required in production. Failing fast prevents the
 *     silent-localhost-routing class of bug where a missing config field
 *     points the plugin at `http://localhost:3000` on a production gateway.
 *
 *   - `databaseUrl` accepts an explicit `pluginConfig.databaseUrl` first,
 *     then falls back to `env.DATABASE_URL`, then throws. The plugin owner
 *     is forced to be explicit about which DB the plugin talks to.
 *
 *   - Unknown fields are stripped (TypeBox `Value.Clean`) so future configs
 *     don't silently leak into the plugin closure.
 *
 * Tested in `config.test.ts`.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const ConfigSchema = Type.Object({
  syntropyBaseUrl: Type.String({ minLength: 1 }),
  databaseUrl: Type.String({ minLength: 1 }),
});

// Vault access is now via the same `databaseUrl` connection (SJ + openclaw
// share a Supabase project). No separate Supabase JS / service-role-key
// config is needed. The plugin probes for SECURITY DEFINER RPC presence
// at startup and falls back to legacy plaintext when they're not yet
// installed. See vault.ts.

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export type SyntropyConfig = Static<typeof ConfigSchema>;

/**
 * Minimal env shape we depend on. Accepting it as a parameter rather than
 * reading `process.env` directly makes the function pure + trivially
 * testable.
 *
 * Modeled as an indexed type for compatibility with NodeJS.ProcessEnv,
 * which is `{ [key: string]: string | undefined }`. The named fields below
 * are the ones we actually consume; everything else is harmlessly accepted.
 */
export type ParseEnv = {
  readonly [key: string]: string | undefined;
} & {
  readonly NODE_ENV?: string;
  readonly DATABASE_URL?: string;
};

const DEV_DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * Validate and normalize plugin configuration.
 *
 * @param raw  Untrusted plugin config (typically `api.pluginConfig`).
 * @param env  Process environment (typically `process.env`).
 * @returns    Validated, fully-populated config.
 * @throws     Error with structured message listing missing/invalid fields.
 */
export function parseSyntropyConfig(
  raw: Record<string, unknown> | undefined | null,
  env: ParseEnv,
): SyntropyConfig {
  const isProduction = env.NODE_ENV === "production";
  const input = raw ?? {};

  // Compose the candidate config from layered sources before validation.
  const syntropyBaseUrl =
    typeof input.syntropyBaseUrl === "string" && input.syntropyBaseUrl.length > 0
      ? input.syntropyBaseUrl
      : isProduction
        ? undefined
        : DEV_DEFAULT_BASE_URL;

  const databaseUrl =
    typeof input.databaseUrl === "string" && input.databaseUrl.length > 0
      ? input.databaseUrl
      : typeof env.DATABASE_URL === "string" && env.DATABASE_URL.length > 0
        ? env.DATABASE_URL
        : undefined;

  const candidate: Record<string, unknown> = {};
  if (syntropyBaseUrl !== undefined) candidate.syntropyBaseUrl = syntropyBaseUrl;
  if (databaseUrl !== undefined) candidate.databaseUrl = databaseUrl;

  const envLabel = isProduction ? "production" : env.NODE_ENV || "development";

  if (!Value.Check(ConfigSchema, candidate)) {
    const errs = [...Value.Errors(ConfigSchema, candidate)].map(
      (e) => `${e.path || "(root)"}: ${e.message}`,
    );
    const fields = errs.length > 0 ? errs.join("; ") : "unknown validation failure";
    throw new Error(`syntropy plugin config invalid (NODE_ENV=${envLabel}): ${fields}`);
  }

  if (!isValidUrl(candidate.syntropyBaseUrl as string)) {
    throw new Error(
      `syntropy plugin config invalid (NODE_ENV=${envLabel}): /syntropyBaseUrl: must be a parseable URL`,
    );
  }

  // Return only the validated shape — strips any extra fields the caller passed in.
  return {
    syntropyBaseUrl: candidate.syntropyBaseUrl as string,
    databaseUrl: candidate.databaseUrl as string,
  };
}
