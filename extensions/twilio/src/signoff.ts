/**
 * ShrineAI identity on SMS replies.
 *
 * SMS has no sender display name — users see only the number — so the agent's
 * identity is carried in the message itself. [PRINCIPAL-RULED 2026-09-29, CTO
 * #12680]: the Shrine agent is reachable over openclaw's SMS number as
 * "ShrineAI", and every SMS reply carries the CEO-GREEN sign-off below. The
 * wording is claim-scope copy: change it only with a new CEO co-sign.
 *
 * Twilio rejects a message body over 1600 characters, so the signed body is
 * fitted to that limit by trimming the REPLY (never the sign-off): the identity
 * must survive even on a long answer.
 */
export const SHRINEAI_SMS_SIGN_OFF = "— ShrineAI, an AI assistant";
/** Twilio's maximum Message `Body` length. */
export const TWILIO_MAX_BODY_CHARS = 1600;

const SEPARATOR = "\n\n";
const ELLIPSIS = "…";

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
    reply = `${reply.slice(0, room - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
    // trimEnd may have shortened it further; that only leaves more headroom.
  }
  return `${reply}${suffix}`;
}
