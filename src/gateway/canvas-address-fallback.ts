/**
 * The canvas host can admit a request without credentials when an authorised
 * control-plane client is connected from the same private address. Operators
 * turn that off with OPENCLAW_CANVAS_ADDRESS_FALLBACK. Env only: config is
 * writable by the agent's own gateway tool.
 *
 * The fallback stays on only when the variable is unset or exactly "on"; any
 * other value, an empty one included, turns it off.
 */
export const CANVAS_ADDRESS_FALLBACK_ENV = "OPENCLAW_CANVAS_ADDRESS_FALLBACK";

export function isCanvasAddressFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CANVAS_ADDRESS_FALLBACK_ENV];
  return raw === undefined || raw === "on";
}
