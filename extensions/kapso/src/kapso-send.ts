/**
 * Kapso WhatsApp outbound send (B-Kapso-1, slice 1) — the Cloud API REST send.
 *
 * Kapso rides Meta's WhatsApp Cloud API via its Meta-proxy: POST a standard
 * Cloud API message payload to `{baseUrl}/{phoneNumberId}/messages` (baseUrl
 * default `https://api.kapso.ai/meta/whatsapp/v24.0`) authenticated with the
 * project API key in the **`X-API-Key`** header (Kapso's recommended auth for
 * the Meta Proxy API — NOT `Authorization: Bearer`). `fetch` is an injectable
 * seam so tests never touch the network; the api key is confined to the header
 * and never surfaced in the returned result (fail-closed secret hygiene). No
 * media in v1.
 */

import { type ResolvedKapsoConfig } from "./kapso-config.js";

/** Injectable fetch seam (defaults to the global `fetch`). */
export type KapsoFetch = typeof fetch;

/** Discriminated send result — success carries the Cloud API message id. */
export type KapsoSendResult =
  | { ok: true; sid: string }
  | { ok: false; status: number | null; error: string };

export type SendKapsoParams = {
  config: ResolvedKapsoConfig;
  /** Resolved sender phone-number-id (explicit config value or derived via kapso-phone.ts). */
  phoneNumberId: string;
  /** Destination E.164 peer number (Cloud API accepts the bare E.164 without `+`, but tolerates it). */
  to: string;
  /** Message text (nudge/CTA/nav only — never PHI; enforced upstream by render-policy). */
  body: string;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: KapsoFetch;
};

/**
 * Send one WhatsApp message via the Cloud API (through Kapso). Returns a
 * discriminated result rather than throwing. The api key is never included in the
 * returned error text.
 */
export async function sendKapsoMessage(params: SendKapsoParams): Promise<KapsoSendResult> {
  const { config, phoneNumberId, to, body } = params;
  const doFetch = params.fetchImpl ?? fetch;

  const url = `${config.baseUrl.replace(/\/$/, "")}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body },
  };

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "X-API-Key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network-level failure (never carries the api key).
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    // Cloud API error bodies describe the request, never the auth header.
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON body — surface the raw text
    }
    return { ok: false, status: response.status, error: message };
  }

  const text = await response.text();
  let data: { messages?: Array<{ id?: string }> };
  try {
    data = (text ? JSON.parse(text) : {}) as { messages?: Array<{ id?: string }> };
  } catch {
    return { ok: false, status: response.status, error: "unparseable Cloud API success body" };
  }
  const sid = data.messages?.[0]?.id;
  if (!sid) {
    return { ok: false, status: response.status, error: "Cloud API response missing message id" };
  }
  return { ok: true, sid };
}
