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
// ---------------------------------------------------------------------------
// REGISTERED CAMPAIGN COPY — must match the A2P 10DLC campaign form BYTE-FOR-BYTE.
// Source: gtm a2p-10dlc shrineai-sms-campaign-DRAFT.md rev 3 (sha256 a07c04fa5223…),
// CEO GREEN #12767, GSM-7 applied per CEO #12799; OPT-OUT from devex #12804, HELP and
// OPT-IN from the CEO's shortened co-sign #12809 (relayed verbatim by devex #12812),
// each keyword reply <= 160 chars (one SMS segment). Carriers compare these to the registered
// campaign: do NOT edit without a new CEO co-sign AND a campaign update.
// Pinned (exact text + GSM-7 charset) by campaign-copy.test.ts.
// ---------------------------------------------------------------------------
/** Sent on STOP (and its synonyms). */
export const OPT_OUT_REPLY =
  "ShrineAI (Shrine Longevity): you're unsubscribed and won't receive more messages. Reply START to resubscribe.";
/** Sent on START (and synonyms) AND on a number's first message (mobile-originated opt-in). */
export const OPT_IN_REPLY =
  "ShrineAI (Shrine Longevity): you're connected. Msg frequency varies; we only reply to you. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
/** Sent on HELP (and synonyms). */
export const HELP_REPLY =
  "ShrineAI (Shrine Longevity) is an AI assistant for account holders. Help: support@syntropyhealth.bio. Msg & data rates may apply. Reply STOP to opt out.";

/** The three keyword replies a channel sends. Required per call — no default — so a
 * channel can never silently fall back to another channel's registered copy. */
export type ComplianceCopy = {
  readonly stop: string;
  readonly start: string;
  readonly help: string;
};

/** SMS (Twilio, number registered under the ShrineAI A2P 10DLC campaign). */
export const SMS_CAMPAIGN_COPY: ComplianceCopy = {
  stop: OPT_OUT_REPLY,
  start: OPT_IN_REPLY,
  help: HELP_REPLY,
};

/** Channels NOT covered by the SMS campaign registration (WhatsApp via kapso). Kept
 * byte-identical to the pre-campaign copy: the A2P ruling scoped SMS only, and
 * re-wording another channel's compliance replies needs its own co-sign. */
export const GENERIC_COMPLIANCE_COPY: ComplianceCopy = {
  stop: "You are unsubscribed from Shrine Longevity messages and will receive no more texts. Reply START to resubscribe.",
  start:
    "You are resubscribed to Shrine Longevity messages. Reply HELP for help, STOP to unsubscribe.",
  help: "Shrine Longevity companion. Msg & data rates may apply. Reply STOP to unsubscribe.",
};

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
  copy: ComplianceCopy,
): Promise<ComplianceOutcome> {
  switch (classifyCompliance(body)) {
    case "stop":
      await store.optOut(from);
      return { kind: "stop", reply: copy.stop };
    case "start":
      await store.optIn(from);
      return { kind: "start", reply: copy.start };
    case "help":
      return { kind: "help", reply: copy.help };
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
