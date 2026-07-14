import { describe, expect, it, vi } from "vitest";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { sendSms } from "./send.js";

const CONFIG: ResolvedTwilioSmsConfig = {
  accountSid: "AC_subaccount",
  apiKeySid: "SK_scoped",
  apiKeySecret: "secret_value_never_leak",
  authToken: "authtok_webhook_only",
  smsNumber: "+15550001234",
  inbound: "pairing",
  allowFrom: [],
};

/** Build a fake fetch returning a Twilio-shaped JSON success. */
function okFetch(
  payload: Record<string, unknown>,
  capture?: (url: string, init: RequestInit) => void,
) {
  return vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(payload), { status: 201 });
  }) as unknown as typeof fetch;
}

describe("sendSms — Twilio REST outbound", () => {
  it("POSTs to the subaccount Messages.json endpoint with the accountSid in the path", async () => {
    let seenUrl = "";
    const fetchImpl = okFetch({ sid: "SM123", status: "queued" }, (u) => {
      seenUrl = u;
    });
    await sendSms({ config: CONFIG, to: "+15557654321", body: "hi", fetchImpl });
    expect(seenUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_subaccount/Messages.json");
  });

  it("authenticates with the SCOPED API KEY (apiKeySid:apiKeySecret), NOT the authToken (§4.2)", async () => {
    let auth = "";
    const fetchImpl = okFetch({ sid: "SM1" }, (_u, init) => {
      auth = (init.headers as Record<string, string>).Authorization;
    });
    await sendSms({ config: CONFIG, to: "+15557654321", body: "hi", fetchImpl });
    const expected = `Basic ${Buffer.from("SK_scoped:secret_value_never_leak").toString("base64")}`;
    expect(auth).toBe(expected);
    // must NOT authenticate with the account/auth-token pair
    expect(auth).not.toBe(
      `Basic ${Buffer.from("AC_subaccount:authtok_webhook_only").toString("base64")}`,
    );
  });

  it("form-encodes From (sender), To (peer), Body (text) with the urlencoded content-type", async () => {
    let body = "";
    let contentType = "";
    const fetchImpl = okFetch({ sid: "SM1" }, (_u, init) => {
      body = (init.body as URLSearchParams).toString();
      contentType = (init.headers as Record<string, string>)["Content-Type"];
    });
    await sendSms({ config: CONFIG, to: "+15557654321", body: "hello world", fetchImpl });
    const params = new URLSearchParams(body);
    expect(params.get("From")).toBe("+15550001234");
    expect(params.get("To")).toBe("+15557654321");
    expect(params.get("Body")).toBe("hello world");
    expect(contentType).toBe("application/x-www-form-urlencoded");
  });

  it("returns { ok: true, sid } from the Twilio JSON response on success", async () => {
    const fetchImpl = okFetch({ sid: "SM_success", status: "queued" });
    const r = await sendSms({ config: CONFIG, to: "+15557654321", body: "hi", fetchImpl });
    expect(r).toEqual({ ok: true, sid: "SM_success", status: "queued" });
  });

  it("returns { ok: false, status } on an HTTP error and NEVER leaks the api-key secret", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number" }), {
          status: 400,
        }),
    ) as unknown as typeof fetch;
    const r = await sendSms({ config: CONFIG, to: "not-e164", body: "hi", fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("Invalid 'To'");
    }
    // fail-closed on secret hygiene: the secret must never appear in the surfaced result
    expect(JSON.stringify(r)).not.toContain("secret_value_never_leak");
  });

  it("returns { ok: false, status: null } when the network call itself throws (no leak)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await sendSms({ config: CONFIG, to: "+15557654321", body: "hi", fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBeNull();
    expect(JSON.stringify(r)).not.toContain("secret_value_never_leak");
  });
});
