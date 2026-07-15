/**
 * Twilio SMS outbound send (B-Twilio-1) — the SMS-flavoured wrapper over the
 * shared {@link sendTwilioMessage} transport (B-Twilio-2 generalized the REST
 * core so SMS and WhatsApp share one code path).
 *
 * Per AD-onboarding-channels §4.2: SMS REST sending authenticates with the
 * SCOPED STANDARD API KEY — basic-auth `apiKeySid:apiKeySecret` — against the
 * subaccount's `accountSid`. The subaccount Auth Token is NEVER used here (it is
 * only the X-Twilio-Signature HMAC key, §4.3). No media in v1.
 */

import { type ResolvedTwilioSmsConfig } from "./config.js";
import { sendTwilioMessage, type SendMessageResult, type SmsFetch } from "./transport.js";

// Back-compat re-exports: compliance/outbound/inbound import these from "./send.js".
export type { SmsFetch } from "./transport.js";
export type SendSmsResult = SendMessageResult;

export type SendSmsParams = {
  config: ResolvedTwilioSmsConfig;
  /** Destination E.164 peer number. */
  to: string;
  /** Message text (nudge/CTA/nav only — never PHI; enforced upstream by render-policy). */
  body: string;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: SmsFetch;
};

/**
 * Send one SMS via Twilio. Thin wrapper over {@link sendTwilioMessage} with the
 * SMS transport (bare-E.164 addresses) and the resolved config's credentials.
 */
export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const { config } = params;
  return sendTwilioMessage({
    auth: {
      accountSid: config.accountSid,
      apiKeySid: config.apiKeySid,
      apiKeySecret: config.apiKeySecret,
    },
    kind: "sms",
    from: config.smsNumber,
    to: params.to,
    body: params.body,
    fetchImpl: params.fetchImpl,
  });
}
