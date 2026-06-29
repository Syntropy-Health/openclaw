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

// Braintrust observability config — default OFF. When enabled, the extension
// initializes a single Braintrust logger and wraps each MCP tool call in a
// span. Project namespace is "claw" (per-app; SJ/others get their own).
//
// ⚠️ PHI SAFETY: syntropy MCP calls carry health data (PHI). Spans default to
// METADATA-ONLY (tool name, label, ok, durationMs) and MUST NOT log raw
// args/results. Setting `logContent: true` sends MCP inputs/outputs (PHI) to
// Braintrust cloud — documented as QA / synthetic-data ONLY. The default-OFF
// path loads no braintrust code at all (lazy dynamic import in index.ts).
const BraintrustSchema = Type.Object({
  enabled: Type.Boolean({ default: false }),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  projectName: Type.String({ minLength: 1, default: "claw" }),
  logContent: Type.Boolean({ default: false }),
});

const ConfigSchema = Type.Object({
  syntropyBaseUrl: Type.String({ minLength: 1 }),
  databaseUrl: Type.String({ minLength: 1 }),
  // KG-direct optional fields — added in SYN-33 Phase C. The extension can
  // talk to shrine-diet-bioactivity's kg-mcp using the same sj_* Bearer
  // (ADR-001 §2). When kgBaseUrl is unset OR enableKgDirect is false the
  // 3 KG-direct tools are not registered.
  kgBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
  enableKgDirect: Type.Optional(Type.Boolean()),
  // Braintrust observability — always present in the resolved config (with
  // defaults applied) so callers can read `cfg.braintrust.enabled` without a
  // null-check. Default is `{ enabled:false, projectName:"claw",
  // logContent:false }` → no-op, zero overhead.
  braintrust: BraintrustSchema,
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
export type BraintrustConfig = Static<typeof BraintrustSchema>;

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
  readonly BRAINTRUST_API_KEY?: string;
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

  // KG-direct (SYN-33). Only forwarded when the caller set them; absent
  // values stay absent so downstream feature-flag logic in index.ts knows
  // to disable the tool registration silently rather than fail.
  if (typeof input.kgBaseUrl === "string" && input.kgBaseUrl.length > 0) {
    candidate.kgBaseUrl = input.kgBaseUrl;
  }
  if (typeof input.enableKgDirect === "boolean") {
    candidate.enableKgDirect = input.enableKgDirect;
  }

  // Braintrust — layer explicit input over env, then let TypeBox defaults
  // (enabled=false, projectName="claw", logContent=false) fill the rest.
  // apiKey resolves: input.braintrust.apiKey ?? env.BRAINTRUST_API_KEY.
  const btInput =
    input.braintrust && typeof input.braintrust === "object"
      ? (input.braintrust as Record<string, unknown>)
      : {};
  const btCandidate: Record<string, unknown> = {};
  if (typeof btInput.enabled === "boolean") btCandidate.enabled = btInput.enabled;
  if (typeof btInput.projectName === "string" && btInput.projectName.length > 0) {
    btCandidate.projectName = btInput.projectName;
  }
  if (typeof btInput.logContent === "boolean") btCandidate.logContent = btInput.logContent;
  const btApiKey =
    typeof btInput.apiKey === "string" && btInput.apiKey.length > 0
      ? btInput.apiKey
      : typeof env.BRAINTRUST_API_KEY === "string" && env.BRAINTRUST_API_KEY.length > 0
        ? env.BRAINTRUST_API_KEY
        : undefined;
  if (btApiKey !== undefined) btCandidate.apiKey = btApiKey;
  // Apply schema defaults + strip unknowns for the nested object.
  candidate.braintrust = Value.Clean(
    BraintrustSchema,
    Value.Default(BraintrustSchema, btCandidate),
  );

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

  if (candidate.kgBaseUrl !== undefined && !isValidUrl(candidate.kgBaseUrl as string)) {
    throw new Error(
      `syntropy plugin config invalid (NODE_ENV=${envLabel}): /kgBaseUrl: must be a parseable URL`,
    );
  }

  // Return only the validated shape — strips any extra fields the caller
  // passed in. KG-direct fields are only included when explicitly set so
  // existing tests that compare against `{ syntropyBaseUrl, databaseUrl }`
  // continue to pass (Vitest toEqual treats undefined values strictly).
  const result: SyntropyConfig = {
    syntropyBaseUrl: candidate.syntropyBaseUrl as string,
    databaseUrl: candidate.databaseUrl as string,
    braintrust: candidate.braintrust as SyntropyConfig["braintrust"],
  };
  if (candidate.kgBaseUrl !== undefined) result.kgBaseUrl = candidate.kgBaseUrl as string;
  if (candidate.enableKgDirect !== undefined) {
    result.enableKgDirect = candidate.enableKgDirect as boolean;
  }
  return result;
}
