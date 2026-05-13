/**
 * Stderr-direct debug writer for the plugin loader.
 *
 * Off by default; opt in with OPENCLAW_DEBUG_PLUGIN_LOADER=1 (or =true).
 * Writes to process.stderr directly so the existing subsystem-console gate
 * cannot filter the output — useful when diagnosing why a deployed gateway
 * is silently dropping a plugin.
 */

let cachedEnabled: boolean | null = null;

function isEnabled(): boolean {
  if (cachedEnabled !== null) {
    return cachedEnabled;
  }
  const raw = process.env.OPENCLAW_DEBUG_PLUGIN_LOADER?.trim();
  cachedEnabled = raw === "1" || raw === "true";
  return cachedEnabled;
}

/**
 * Test-only escape hatch — reset the cached env-var lookup between cases.
 *
 * DO NOT call from production code. The cache exists to make `debugLoader`
 * cheap (no env read per call); resetting it from a non-test path defeats
 * that and races with concurrent callers. Vitest is the only legitimate
 * consumer. Guarded by NODE_ENV to silently no-op in production.
 */
export function resetDebugLoaderCacheForTests(): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  cachedEnabled = null;
}

export function debugLoader(message: string): void {
  if (!isEnabled()) {
    return;
  }
  try {
    process.stderr.write(`OPENCLAW_PLUGIN_LOADER: ${message}\n`);
  } catch {
    // ignore EPIPE — diagnostic must never crash the host
  }
}
