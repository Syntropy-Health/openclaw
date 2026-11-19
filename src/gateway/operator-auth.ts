import type { GatewayAuthResult } from "./auth.js";

/**
 * Authentication methods that carry operator authority: the gateway's own
 * shared token or password, a verified Tailscale user, or an identity asserted
 * by a configured trusted proxy. Anything else (an end-user sign-in, a result
 * with no method, or a method added later) is not an operator.
 */
const OPERATOR_AUTH_METHODS: ReadonlySet<string> = new Set([
  "token",
  "password",
  "tailscale",
  "trusted-proxy",
]);

export function isOperatorAuth(result: GatewayAuthResult): boolean {
  return result.ok && result.method !== undefined && OPERATOR_AUTH_METHODS.has(result.method);
}
