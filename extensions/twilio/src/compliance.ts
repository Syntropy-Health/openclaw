/**
 * TCPA compliance hard rail (B-Twilio-1, slice 4 — QG-BLOCKING, CTO #3559).
 *
 * US SMS law (TCPA) + carrier rules require honoring opt-out keywords. This
 * module is the non-negotiable rail: inbound STOP/UNSUBSCRIBE/… keywords are
 * intercepted BEFORE the agent, persist a durable opt-out, and the send path
 * checks that opt-out FAIL-CLOSED so a STOP'd number receives ZERO further
 * messages. SMS does not go live until the behavioral pin (a STOP'd number
 * gets zero subsequent sends) is green.
 *
 * Keyword matching is EXACT (trimmed, case-insensitive, trailing punctuation
 * stripped) — conversational text that merely contains "stop" must NOT trigger
 * a false opt-out. This mirrors Twilio's Advanced Opt-Out keyword semantics.
 */

import { sendSms, type SendSmsParams, type SendSmsResult } from "./send.js";

/** Durable opt-out store — persisted so opt-outs survive restarts (impl wired at slice 5). */
export type OptOutStore = {
  isOptedOut(e164: string): boolean | Promise<boolean>;
  optOut(e164: string): void | Promise<void>;
  optIn(e164: string): void | Promise<void>;
};

export type ComplianceKeyword = "stop" | "start" | "help";

// Twilio standard opt-out / opt-in / help keyword sets (exact-match).
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "YES", "UNSTOP"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

/**
 * Classify a message body as a compliance keyword, or null if it is ordinary
 * content. Exact match only (after trim / uppercase / trailing-punctuation
 * strip) so "please help me" or "I won't stop" never opt a user out.
 */
export function classifyCompliance(body: string): ComplianceKeyword | null {
  const normalized = body
    .trim()
    .toUpperCase()
    .replace(/[.!?]+$/, "")
    .trim();
  if (STOP_WORDS.has(normalized)) return "stop";
  if (START_WORDS.has(normalized)) return "start";
  if (HELP_WORDS.has(normalized)) return "help";
  return null;
}

// Compliance reply copy — generic, no PHI / clerk-id / pairing code.
const STOP_REPLY =
  "You are unsubscribed from Shrine Longevity messages and will receive no more texts. Reply START to resubscribe.";
const START_REPLY =
  "You are resubscribed to Shrine Longevity messages. Reply HELP for help, STOP to unsubscribe.";
const HELP_REPLY =
  "Shrine Longevity companion. Msg & data rates may apply. Reply STOP to unsubscribe.";

export type ComplianceOutcome =
  | { kind: "stop"; reply: string }
  | { kind: "start"; reply: string }
  | { kind: "help"; reply: string }
  | { kind: "passthrough" };

/**
 * Process an inbound message for compliance keywords BEFORE the agent sees it.
 * STOP persists an opt-out; START clears it; HELP replies without state change;
 * anything else passes through to the agent. The returned `reply` (when present)
 * is the compliance response the caller must send.
 */
export async function handleInboundCompliance(
  from: string,
  body: string,
  store: OptOutStore,
): Promise<ComplianceOutcome> {
  switch (classifyCompliance(body)) {
    case "stop":
      await store.optOut(from);
      return { kind: "stop", reply: STOP_REPLY };
    case "start":
      await store.optIn(from);
      return { kind: "start", reply: START_REPLY };
    case "help":
      return { kind: "help", reply: HELP_REPLY };
    default:
      return { kind: "passthrough" };
  }
}

/** A send suppressed by the opt-out rail — carries no message SID. */
export type SuppressedSend = { ok: false; suppressed: true };

/**
 * Send an SMS ONLY if the destination has not opted out. This is the enforcement
 * half of the rail: the opt-out check is FAIL-CLOSED — if the store errors, the
 * send is suppressed rather than risking a message to a STOP'd number. On a
 * clean, non-opted number it delegates to {@link sendSms}.
 */
export async function guardedSendSms(
  params: SendSmsParams,
  store: OptOutStore,
): Promise<SendSmsResult | SuppressedSend> {
  let optedOut: boolean;
  try {
    optedOut = await store.isOptedOut(params.to);
  } catch {
    // Fail-closed: an unavailable opt-out store must NOT let a send through.
    return { ok: false, suppressed: true };
  }
  if (optedOut) return { ok: false, suppressed: true };
  return sendSms(params);
}
