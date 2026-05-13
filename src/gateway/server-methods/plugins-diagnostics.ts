import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import type { PluginRecord } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginDiagnostic } from "../../plugins/types.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Whitelisted plugin fields exposed via the diagnostics RPC.
 *
 * Mirrors the decision-level data the in-process `debugLoader` writes to
 * stderr but does NOT include `configJsonSchema`, `configUiHints`, or any
 * other potentially sensitive internal state — operators only need to know
 * "did the plugin load, and if not, why?".
 */
type PluginDiagnosticsRecord = {
  id: string;
  name: string;
  version: string | null;
  origin: PluginRecord["origin"];
  source: string;
  status: PluginRecord["status"];
  enabled: boolean;
  error: string | null;
};

type PluginDiagnosticsPayload = {
  bundledPluginsDir: string | null;
  plugins: PluginDiagnosticsRecord[];
  diagnostics: PluginDiagnostic[];
};

function toDiagnosticsRecord(record: PluginRecord): PluginDiagnosticsRecord {
  return {
    id: record.id,
    name: record.name,
    version: record.version ?? null,
    origin: record.origin,
    source: record.source,
    status: record.status,
    enabled: record.enabled,
    error: record.error ?? null,
  };
}

/**
 * Admin-only RPC method exposing plugin-registry diagnostics. Surfaces the
 * decision-level state that the in-process `debugLoader` writes to stderr,
 * so an operator can curl the live gateway without SSH access.
 *
 * Scope: requires `operator.admin` (NOT in READ_METHODS or WRITE_METHODS).
 *
 * Rationale: the payload includes absolute filesystem paths for every
 * registered plugin (the `source` field), which discloses internal
 * directory layout. Gate behind the admin scope so the bootstrap operator
 * token is the only credential that can retrieve it.
 *
 * Method name: `gateway.plugins.diagnostics`
 *
 * Payload shape:
 *   bundledPluginsDir: string | null — resolved extensions root (null if discovery failed)
 *   plugins: array of whitelisted PluginRecord fields (NO config schema, NO internals)
 *   diagnostics: full diagnostics array from the loader
 */
export const pluginsDiagnosticsHandlers: GatewayRequestHandlers = {
  "gateway.plugins.diagnostics": ({ respond }) => {
    const bundledPluginsDir = resolveBundledPluginsDir() ?? null;
    const registry = getActivePluginRegistry();
    if (!registry) {
      const payload: PluginDiagnosticsPayload = {
        bundledPluginsDir,
        plugins: [],
        diagnostics: [],
      };
      respond(true, payload, undefined);
      return;
    }
    const payload: PluginDiagnosticsPayload = {
      bundledPluginsDir,
      plugins: registry.plugins.map(toDiagnosticsRecord),
      diagnostics: registry.diagnostics,
    };
    respond(true, payload, undefined);
  },
};
