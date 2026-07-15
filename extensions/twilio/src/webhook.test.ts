import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decideInboundSms, parseInboundSms } from "./webhook.js";

const AUTH_TOKEN = "subaccount_auth_token_hmac_key";
const URL = "https://hooks.example.com/twilio/sms";

/** Compute a genuine Twilio X-Twilio-Signature (URL + sorted params, HMAC-SHA1, base64). */
function twilioSign(url: string, params: URLSearchParams): string {
  const sorted = Array.from(params.entries()).toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  let data = url;
  for (const [k, v] of sorted) data += k + v;
  return crypto.createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
}

function form(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe("parseInboundSms", () => {
  it("extracts { from, body } from Twilio inbound form params", () => {
    expect(parseInboundSms(form({ From: "+15557654321", Body: "hello" }))).toEqual({
      from: "+15557654321",
      body: "hello",
    });
  });
  it("defaults an absent Body to empty string (From is the required field)", () => {
    expect(parseInboundSms(form({ From: "+15557654321" }))).toEqual({
      from: "+15557654321",
      body: "",
    });
  });
  it("returns null when From is missing (unroutable)", () => {
    expect(parseInboundSms(form({ Body: "orphan" }))).toBeNull();
  });
});

describe("decideInboundSms — signature validated BEFORE routing", () => {
  const params = form({ From: "+15557654321", Body: "log an apple" });

  it("rejects a non-POST method with 405 (never validates/routes)", () => {
    const d = decideInboundSms({
      method: "GET",
      signature: twilioSign(URL, params),
      url: URL,
      bodyParams: params,
      authToken: AUTH_TOKEN,
    });
    expect(d).toEqual({ status: 405 });
  });

  it("rejects an INVALID signature with 403 and does NOT surface inbound (security gate)", () => {
    const d = decideInboundSms({
      method: "POST",
      signature: "totally-wrong-signature",
      url: URL,
      bodyParams: params,
      authToken: AUTH_TOKEN,
    });
    expect(d).toEqual({ status: 403 });
    expect("inbound" in d).toBe(false);
  });

  it("rejects a MISSING signature with 403", () => {
    const d = decideInboundSms({
      method: "POST",
      signature: undefined,
      url: URL,
      bodyParams: params,
      authToken: AUTH_TOKEN,
    });
    expect(d).toEqual({ status: 403 });
  });

  it("accepts a VALID signature and surfaces the parsed inbound with 200", () => {
    const d = decideInboundSms({
      method: "POST",
      signature: twilioSign(URL, params),
      url: URL,
      bodyParams: params,
      authToken: AUTH_TOKEN,
    });
    expect(d).toEqual({ status: 200, inbound: { from: "+15557654321", body: "log an apple" } });
  });

  it("a tampered body invalidates the signature → 403 (integrity, not just presence)", () => {
    const goodSig = twilioSign(URL, params);
    const tampered = form({ From: "+15557654321", Body: "DIFFERENT body" });
    const d = decideInboundSms({
      method: "POST",
      signature: goodSig,
      url: URL,
      bodyParams: tampered,
      authToken: AUTH_TOKEN,
    });
    expect(d).toEqual({ status: 403 });
  });

  it("returns 400 when the signature is valid but From is missing (authenticated-but-unroutable)", () => {
    const noFrom = form({ Body: "no sender" });
    const d = decideInboundSms({
      method: "POST",
      signature: twilioSign(URL, noFrom),
      url: URL,
      bodyParams: noFrom,
      authToken: AUTH_TOKEN,
    });
    expect(d).toEqual({ status: 400 });
  });
});
