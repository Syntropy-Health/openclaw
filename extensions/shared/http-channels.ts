import { deriveChannel } from "./session-key.js";

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
 *
 * EDITING THIS SET CHANGES ACCESS, NOT JUST COPY: auth-memory-gate also uses it
 * to short-circuit unidentified turns (and to fail closed when no peer is found).
 * Adding a channel here hard-gates that channel; it fails closed, not open.
 *
 * Known conflation (accepted, operator-only): the Control UI's WebSocket chat
 * (`chat.send`) also reports channel "webchat" (INTERNAL_MESSAGE_CHANNEL) and DOES
 * dispatch chat commands. Its default session peer is "main", which the syntropy
 * data gate skips, so in normal use the data-gate copy does not apply there. The
 * identity gate's treatment of "webchat" predates this module and is unchanged.
 */
export const HTTP_GATE_CHANNELS: ReadonlySet<string> = new Set(["webchat", "shrinemobile"]);

/** True when `channel` is an HTTP surface where chat commands do not dispatch. */
export function isHttpGateChannel(channel: string | null | undefined): boolean {
  return typeof channel === "string" && HTTP_GATE_CHANNELS.has(channel);
}

/** Session-key channel segments the gateway HTTP chat path mints (http-utils.ts). */
const HTTP_SESSION_KEY_CHANNELS: ReadonlySet<string> = new Set([
  "openresponses-user",
  "openai-user",
]);

/**
 * True for a session that arrived over the HTTP chat surface: the reported
 * channel is an HTTP gate channel, or the session key's channel segment is one
 * the gateway HTTP path mints (`openresponses-user` / `openai-user`), or is an
 * HTTP gate channel itself (a raw `X-OpenClaw-Session-Key`).
 *
 * On such a session the session key's tail is CLIENT-INFLUENCED (body `user`,
 * the session-key header), so an UNVERIFIED turn must never resolve an identity
 * by (channel, peer). Shared by syntropy, persist-user-identity and
 * auth-memory-gate so the three hooks cannot disagree.
 */
export function isHttpShapedSession(
  channel: string | null | undefined,
  sessionKey: string | null | undefined,
): boolean {
  if (isHttpGateChannel(channel)) {
    return true;
  }
  const keyChannel = deriveChannel(sessionKey ?? "");
  return HTTP_SESSION_KEY_CHANNELS.has(keyChannel) || isHttpGateChannel(keyChannel);
}
