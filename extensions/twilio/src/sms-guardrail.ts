/**
 * No-medical-advice guardrail for SMS turns.
 *
 * WHICH PROMPT AN SMS TURN RUNS UNDER (measured, not assumed): the inbound route
 * hands the turn to agent `main` (session key `agent:main:sms:direct:<e164>`), whose
 * system prompt is OpenClaw's generic builder ("You are a personal assistant running
 * inside OpenClaw.") plus the workspace AGENTS.md/SOUL.md. None of those say anything
 * about medical advice. So the SMS surface adds its own instruction here.
 *
 * WHY prependContext, NOT systemPrompt: `before_agent_start` results are merged by the
 * hook runner, but only `prependContext` is consumed by the run (attempt.ts); a hook's
 * `systemPrompt` field is merged and then never read. Returning it would look like a
 * guardrail and do nothing. prependContext lands at the head of the user turn on EVERY
 * SMS turn, which is what this needs.
 *
 * Wording: [OPENCLAW-JUDGEMENT] — this is an instruction to the model, not customer
 * copy; the customer-facing registered strings live in compliance.ts.
 */
export const SMS_NO_MEDICAL_ADVICE_GUARDRAIL = [
  "[SMS_SAFETY] channel: sms",
  "You are ShrineAI, an AI assistant for Shrine Longevity account holders, replying by SMS.",
  "You are NOT a doctor, pharmacist or other healthcare professional, and you MUST NOT give medical advice:",
  "- Do not diagnose, interpret symptoms or test results, or say what condition someone has.",
  "- Do not recommend, start, stop, change or dose any medication, supplement, peptide or treatment.",
  "- Do not advise on drug interactions, side effects, or whether something is safe for this person.",
  "If asked for any of that, say you can't give medical advice by text and suggest they speak with their clinician or pharmacist.",
  "If the message describes a possible emergency, tell them to call 911 (or their local emergency number) now.",
  "You MAY help with the account, orders, shipping, billing and how to use the app.",
].join("\n");

/** `before_agent_start` handler body: the guardrail on SMS turns, nothing otherwise. */
export function smsGuardrailFor(ctx: { messageProvider?: string } | undefined): {
  prependContext?: string;
} {
  return ctx?.messageProvider === "sms" ? { prependContext: SMS_NO_MEDICAL_ADVICE_GUARDRAIL } : {};
}
