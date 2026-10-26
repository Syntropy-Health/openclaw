/**
 * HTTP chat surfaces (`x-openclaw-channel` allowlist, src/gateway/http-utils.ts).
 *
 * Turns on these channels go straight to the agent with NO plugin-command
 * dispatch, so chat commands such as `!identify` / `!verify` cannot run there.
 * A user on these surfaces is identified by signing in (Clerk), which binds the
 * device ([G1]).
 *
 * Single source of truth: auth-memory-gate (identity gate copy) and syntropy
 * (data gate copy) both read this set, so the two gates can never disagree about
 * which channels can run chat commands.
 */
export const HTTP_GATE_CHANNELS: ReadonlySet<string> = new Set(["webchat", "shrinemobile"]);

/** True when `channel` is an HTTP surface where chat commands do not dispatch. */
export function isHttpGateChannel(channel: string | null | undefined): boolean {
  return typeof channel === "string" && HTTP_GATE_CHANNELS.has(channel);
}
