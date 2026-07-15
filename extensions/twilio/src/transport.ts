/**
 * Twilio message transport (B-Twilio-2, slice 1) — the channel-parametrized REST
 * send shared by SMS and WhatsApp (WABA).
 *
 * Twilio WhatsApp uses the SAME `Messages.json` endpoint as SMS; the only wire
 * difference is that WhatsApp `From`/`To` addresses are `whatsapp:`-prefixed.
 * So the B-Twilio-1 send primitive generalizes to both transports by prefixing
 * the addresses — the vendor-agnostic rail holds (only this extension is
 * Twilio-aware). Auth (scoped API key), form-encoding, the discriminated result,
 * and secret hygiene are identical across transports.
 */

const TWILIO_API_ROOT = "https://api.twilio.com/2010-04-01";

/** Injectable fetch seam (defaults to the global `fetch`). */
export type SmsFetch = typeof fetch;

/** Discriminated send result — success carries the Twilio message SID. */
export type SendMessageResult =
  | { ok: true; sid: string; status?: string }
  | { ok: false; status: number | null; error: string };

/** Twilio transport channel — selects the address prefix. */
export type TwilioTransportKind = "sms" | "whatsapp";

/** REST auth: the scoped Standard API Key against the subaccount (never the auth token). */
export type TwilioAuth = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
};

/**
 * Format an address for the transport. WhatsApp addresses are `whatsapp:`-prefixed;
 * SMS addresses are bare E.164. Idempotent — never double-prefixes.
 */
export function twilioAddress(kind: TwilioTransportKind, address: string): string {
  if (kind !== "whatsapp") return address;
  return `whatsapp:${address.replace(/^whatsapp:/, "")}`;
}

/**
 * The bare E.164 for an inbound address, stripping any `whatsapp:` prefix. Used
 * for opt-out keying and session routing so a number is identified the same way
 * regardless of transport (a STOP from `whatsapp:+1…` opts out the same peer).
 */
export function bareAddress(address: string): string {
  return address.replace(/^whatsapp:/, "").trim();
}

/**
 * Send one message via the Twilio REST API for the given transport. Returns a
 * discriminated result rather than throwing; the api-key secret is never
 * included in the returned error text.
 */
export async function sendTwilioMessage(params: {
  auth: TwilioAuth;
  kind: TwilioTransportKind;
  /** Bare E.164 sender (prefixed per transport). */
  from: string;
  /** Bare E.164 recipient (prefixed per transport). */
  to: string;
  body: string;
  fetchImpl?: SmsFetch;
}): Promise<SendMessageResult> {
  const { auth, kind } = params;
  const doFetch = params.fetchImpl ?? fetch;

  const url = `${TWILIO_API_ROOT}/Accounts/${auth.accountSid}/Messages.json`;
  const basic = Buffer.from(`${auth.apiKeySid}:${auth.apiKeySecret}`).toString("base64");
  const form = new URLSearchParams({
    From: twilioAddress(kind, params.from),
    To: twilioAddress(kind, params.to),
    Body: params.body,
  });

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
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
    return { ok: false, status: response.status, error: "unparseable Twilio success body" };
  }
  if (!data.sid) {
    return { ok: false, status: response.status, error: "Twilio response missing message sid" };
  }
  return data.status !== undefined
    ? { ok: true, sid: data.sid, status: data.status }
    : { ok: true, sid: data.sid };
}
