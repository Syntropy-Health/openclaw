import { describe, expect, it, vi } from "vitest";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import { sendKapsoMessage } from "./kapso-send.js";

const CONFIG: ResolvedKapsoConfig = {
  apiKey: "kapso_key_never_leak",
  baseUrl: "https://api.kapso.ai/whatsapp",
  phoneNumberId: "PN_123",
  appSecret: "app_secret",
  inbound: "pairing",
  allowFrom: [],
};

function capturingFetch(payload: unknown = { messages: [{ id: "wamid.ABC" }] }) {
  const seen: { url: string; auth: string; contentType: string; body: string }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    seen.push({
      url,
      auth: h.Authorization,
      contentType: h["Content-Type"],
      body: String(init.body),
    });
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe("sendKapsoMessage — WhatsApp Cloud API send", () => {
  it("POSTs to {baseUrl}/{phoneNumberId}/messages with Bearer api-key auth + JSON", async () => {
    const { fn, seen } = capturingFetch();
    await sendKapsoMessage({ config: CONFIG, to: "+15557654321", body: "hi", fetchImpl: fn });
    expect(seen[0].url).toBe("https://api.kapso.ai/whatsapp/PN_123/messages");
    expect(seen[0].auth).toBe("Bearer kapso_key_never_leak");
    expect(seen[0].contentType).toBe("application/json");
  });

  it("sends a standard Cloud API text payload (messaging_product, to, text.body)", async () => {
    const { fn, seen } = capturingFetch();
    await sendKapsoMessage({
      config: CONFIG,
      to: "+15557654321",
      body: "your nudge",
      fetchImpl: fn,
    });
    const sent = JSON.parse(seen[0].body) as {
      messaging_product: string;
      to: string;
      type: string;
      text: { body: string };
    };
    expect(sent.messaging_product).toBe("whatsapp");
    expect(sent.to).toBe("+15557654321");
    expect(sent.type).toBe("text");
    expect(sent.text.body).toBe("your nudge");
  });

  it("returns { ok: true, sid } from the Cloud API message id on success", async () => {
    const { fn } = capturingFetch({ messages: [{ id: "wamid.SUCCESS" }] });
    const r = await sendKapsoMessage({
      config: CONFIG,
      to: "+15557654321",
      body: "hi",
      fetchImpl: fn,
    });
    expect(r).toEqual({ ok: true, sid: "wamid.SUCCESS" });
  });

  it("returns { ok: false, status } on an HTTP error and NEVER leaks the api key", async () => {
    const fn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Unsupported recipient" } }), {
          status: 400,
        }),
    ) as unknown as typeof fetch;
    const r = await sendKapsoMessage({ config: CONFIG, to: "bad", body: "hi", fetchImpl: fn });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("Unsupported recipient");
    }
    expect(JSON.stringify(r)).not.toContain("kapso_key_never_leak");
  });

  it("returns { ok: false, status: null } when the network throws (no leak)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await sendKapsoMessage({
      config: CONFIG,
      to: "+15557654321",
      body: "hi",
      fetchImpl: fn,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBeNull();
    expect(JSON.stringify(r)).not.toContain("kapso_key_never_leak");
  });

  it("returns a failure result when the Cloud API 200 has no message id", async () => {
    const { fn } = capturingFetch({ messages: [] });
    const r = await sendKapsoMessage({
      config: CONFIG,
      to: "+15557654321",
      body: "hi",
      fetchImpl: fn,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing message id/i);
  });
});
