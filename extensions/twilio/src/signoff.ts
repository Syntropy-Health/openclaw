/**
 * ShrineAI identity on SMS replies.
 *
 * SMS has no sender display name — users see only the number — so the agent's
 * identity is carried in the message itself. [PRINCIPAL-RULED 2026-09-29, CTO
 * #12680]: the Shrine agent is reachable over openclaw's SMS number as
 * "ShrineAI", and every SMS reply carries the CEO-GREEN sign-off below — an ASCII
 * hyphen per the CEO's GSM-7 ruling (#12799), so replies stay in the GSM-7
 * charset (no Smart Encoding on this path). It is registered A2P campaign copy:
 * change it only with a new CEO co-sign AND a campaign update.
 *
 * Twilio rejects a message body over 1600 characters, so the signed body is
 * fitted to that limit by trimming the REPLY (never the sign-off): the identity
 * must survive even on a long answer.
 */
export const SHRINEAI_SMS_SIGN_OFF = "- ShrineAI, an AI assistant";
/** Twilio's maximum Message `Body` length. */
export const TWILIO_MAX_BODY_CHARS = 1600;

// One space, exactly as the registered campaign samples show
// ("…STOP to opt out. - ShrineAI, an AI assistant").
const SEPARATOR = " ";
// ASCII, not "…": this marker is ours (not CEO copy) and must not by itself
// push a message out of the GSM-7 charset into costlier UCS-2 encoding.
const ELLIPSIS = "...";

/**
 * Longest prefix of `s` that is at most `max` UTF-16 code units and never ends
 * inside a surrogate pair (a split emoji would reach the handset as U+FFFD).
 * `length` counts code units, which is >= characters, so the limit stays safe.
 */
function cutToCodeUnits(s: string, max: number): string {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) {
      break;
    }
    out += ch;
  }
  return out;
}

export function withShrineAiSignOff(text: string): string {
  let reply = text.trimEnd();
  // Idempotent: strip an existing sign-off so it is never doubled.
  if (reply.endsWith(SHRINEAI_SMS_SIGN_OFF)) {
    reply = reply.slice(0, -SHRINEAI_SMS_SIGN_OFF.length).trimEnd();
  }
  if (reply.length === 0) {
    return SHRINEAI_SMS_SIGN_OFF;
  }
  const suffix = `${SEPARATOR}${SHRINEAI_SMS_SIGN_OFF}`;
  const room = TWILIO_MAX_BODY_CHARS - suffix.length;
  if (reply.length > room) {
    reply = `${cutToCodeUnits(reply, room - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
    // trimEnd may have shortened it further; that only leaves more headroom.
  }
  return `${reply}${suffix}`;
}
