import { describe, expect, it, vi } from "vitest";
import { bareAddress, sendTwilioMessage, twilioAddress, type TwilioAuth } from "./transport.js";

const AUTH: TwilioAuth = {
  accountSid: "AC_sub",
  apiKeySid: "SK_scoped",
  apiKeySecret: "secret_never_leak",
};

function capturingFetch(payload: Record<string, unknown> = { sid: "SM1", status: "queued" }) {
  const seen: { url: string; auth: string; from: string; to: string; body: string }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const p = init.body as URLSearchParams;
    seen.push({
      url,
      auth: (init.headers as Record<string, string>).Authorization,
      from: p.get("From") ?? "",
      to: p.get("To") ?? "",
      body: p.get("Body") ?? "",
    });
    return new Response(JSON.stringify(payload), { status: 201 });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe("twilioAddress", () => {
  it("leaves SMS addresses bare", () => {
    expect(twilioAddress("sms", "+15550001234")).toBe("+15550001234");
  });
  it("prefixes WhatsApp addresses with 'whatsapp:'", () => {
    expect(twilioAddress("whatsapp", "+15550001234")).toBe("whatsapp:+15550001234");
  });
  it("is idempotent — never double-prefixes an already-prefixed WhatsApp address", () => {
    expect(twilioAddress("whatsapp", "whatsapp:+15550001234")).toBe("whatsapp:+15550001234");
  });
});

describe("bareAddress — inbound normalization for opt-out keying / routing", () => {
  it("strips a 'whatsapp:' prefix to the bare E.164", () => {
    expect(bareAddress("whatsapp:+15557654321")).toBe("+15557654321");
  });
  it("leaves a bare SMS number unchanged", () => {
    expect(bareAddress("+15557654321")).toBe("+15557654321");
  });
  it("round-trips with twilioAddress (prefix → strip = identity)", () => {
    const e164 = "+15557654321";
    expect(bareAddress(twilioAddress("whatsapp", e164))).toBe(e164);
  });
});

describe("sendTwilioMessage", () => {
  it("SMS: bare From/To on Messages.json with scoped-API-key basic auth", async () => {
    const { fn, seen } = capturingFetch();
    const r = await sendTwilioMessage({
      auth: AUTH,
      kind: "sms",
      from: "+15550001234",
      to: "+15557654321",
      body: "hi",
      fetchImpl: fn,
    });
    expect(r).toEqual({ ok: true, sid: "SM1", status: "queued" });
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_sub/Messages.json");
    expect(seen[0].auth).toBe(
      `Basic ${Buffer.from("SK_scoped:secret_never_leak").toString("base64")}`,
    );
    expect(seen[0].from).toBe("+15550001234");
    expect(seen[0].to).toBe("+15557654321");
  });

  it("★ WhatsApp (WABA): From/To carry the 'whatsapp:' prefix; same endpoint + auth", async () => {
    const { fn, seen } = capturingFetch();
    const r = await sendTwilioMessage({
      auth: AUTH,
      kind: "whatsapp",
      from: "+15550001234",
      to: "+15557654321",
      body: "your nudge",
      fetchImpl: fn,
    });
    expect(r.ok).toBe(true);
    expect(seen[0].from).toBe("whatsapp:+15550001234");
    expect(seen[0].to).toBe("whatsapp:+15557654321");
    expect(seen[0].body).toBe("your nudge");
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_sub/Messages.json");
  });

  it("returns { ok: false, status } on an HTTP error and NEVER leaks the api-key secret", async () => {
    const fn = vi.fn(
      async () => new Response(JSON.stringify({ message: "Channel not found" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const r = await sendTwilioMessage({
      auth: AUTH,
      kind: "whatsapp",
      from: "+15550001234",
      to: "+15557654321",
      body: "hi",
      fetchImpl: fn,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("Channel not found");
    }
    expect(JSON.stringify(r)).not.toContain("secret_never_leak");
  });

  it("returns { ok: false, status: null } when the network throws (no leak)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await sendTwilioMessage({
      auth: AUTH,
      kind: "sms",
      from: "+15550001234",
      to: "+15557654321",
      body: "hi",
      fetchImpl: fn,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBeNull();
    expect(JSON.stringify(r)).not.toContain("secret_never_leak");
  });
});
