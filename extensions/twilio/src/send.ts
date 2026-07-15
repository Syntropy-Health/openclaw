/**
 * Twilio SMS outbound send (B-Twilio-1, slice 2) — the REST send primitive.
 *
 * Per AD-onboarding-channels §4.2: SMS REST sending authenticates with the
 * SCOPED STANDARD API KEY — basic-auth `apiKeySid:apiKeySecret` — against the
 * subaccount's `accountSid` in the URL path. The subaccount Auth Token is
 * NEVER used here (it is only the X-Twilio-Signature HMAC key, §4.3).
 *
 * `fetch` is an injectable seam so tests never touch the network. Secrets are
 * confined to the Authorization header construction and never surfaced in the
 * returned result (fail-closed secret hygiene — a compromised log/return path
 * must not leak the API key secret).
 *
 * This module is the low-level send; mapping to the channel adapter's
 * OutboundDeliveryResult is the plugin-wiring layer (slice 5). No media in v1.
 */

import { type ResolvedTwilioSmsConfig } from "./config.js";

const TWILIO_API_ROOT = "https://api.twilio.com/2010-04-01";

/** Injectable fetch seam (defaults to the global `fetch`). */
export type SmsFetch = typeof fetch;

/** Discriminated send result — success carries the Twilio message SID. */
export type SendSmsResult =
  | { ok: true; sid: string; status?: string }
  | { ok: false; status: number | null; error: string };

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
 * Send one SMS via the Twilio REST API. Returns a discriminated result rather
 * than throwing, so callers branch on `ok` without a try/catch. The api-key
 * secret is never included in the returned error text.
 */
export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const { config, to, body } = params;
  const doFetch = params.fetchImpl ?? fetch;

  const url = `${TWILIO_API_ROOT}/Accounts/${config.accountSid}/Messages.json`;
  const auth = Buffer.from(`${config.apiKeySid}:${config.apiKeySecret}`).toString("base64");
  const form = new URLSearchParams({ From: config.smsNumber, To: to, Body: body });

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
  } catch (err) {
    // Network-level failure (never carries the request body/secret).
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    // Twilio error payloads are safe to surface (they describe the request
    // params, never the auth header). Prefer the structured `message`.
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // non-JSON body — surface the raw text
    }
    return { ok: false, status: response.status, error: message };
  }

  const text = await response.text();
  let data: { sid?: string; status?: string };
  try {
    data = (text ? JSON.parse(text) : {}) as { sid?: string; status?: string };
  } catch {
    // Contract: sendSms never throws. A 2xx with a non-JSON body is degraded to
    // a failure result (mirrors the error-path parse handling).
    return { ok: false, status: response.status, error: "unparseable Twilio success body" };
  }
  if (!data.sid) {
    return { ok: false, status: response.status, error: "Twilio response missing message sid" };
  }
  return data.status !== undefined
    ? { ok: true, sid: data.sid, status: data.status }
    : { ok: true, sid: data.sid };
}
