import { describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../../src/channels/plugins/types.adapters.js";
import { type OptOutStore } from "../../twilio/src/compliance.js";
import { createKapsoOutboundTransport, KAPSO_OUTBOUND_SUPPRESSED } from "./index.js";
import { type ResolvedKapsoConfig } from "./kapso-config.js";

const RESOLVED: ResolvedKapsoConfig = {
  apiKey: "k",
  baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
  phoneNumberId: "PN_1",
  appSecret: "s",
  inbound: "pairing",
  allowFrom: [],
};

function memStore(seed: string[] = []): OptOutStore & { set: Set<string> } {
  const set = new Set(seed);
  return { set, isOptedOut: (n) => set.has(n), optOut: () => {}, optIn: () => {} };
}

function okFetch() {
  const calls: Array<{ url: string; to: string; body: string }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { to?: string; text?: { body?: string } };
    calls.push({ url, to: payload.to ?? "", body: payload.text?.body ?? "" });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ctx = (to: string, text: string): ChannelOutboundContext =>
  ({ to, text }) as ChannelOutboundContext;

describe("createKapsoOutboundTransport — proactive WhatsApp send (B-Kapso slice 3b)", () => {
  it("★ sends a non-opted proactive message, normalizes the JID → +E164, returns the sid", async () => {
    const store = memStore();
    const { fn, calls } = okFetch();
    const send = createKapsoOutboundTransport({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      fetchImpl: fn,
    });
    const res = await send(ctx("15557654321@s.whatsapp.net", "nudge"));
    expect(res.messageId).toBe("wamid.OUT");
    expect(res.channel).toBe("whatsapp");
    expect(fn).toHaveBeenCalledTimes(1); // exactly one send (no double-send)
    expect(calls[0].body).toBe("nudge");
    expect(calls[0].to).toBe("+15557654321"); // JID → +E164 for the Cloud API + opt-out keyspace
    expect(calls[0].url).toContain("/PN_1/messages"); // resolved phone-number-id endpoint
  });

  it("★ device-suffixed JID normalizes to the plain +E164 (device id not folded in)", async () => {
    const store = memStore();
    const { fn, calls } = okFetch();
    const send = createKapsoOutboundTransport({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      fetchImpl: fn,
    });
    await send(ctx("15557654321:12@s.whatsapp.net", "hi"));
    expect(calls[0].to).toBe("+15557654321"); // NOT +155576543212
  });

  it("★ rejects a group JID (Cloud API can't send to a group) without sending", async () => {
    const store = memStore();
    const { fn } = okFetch();
    const send = createKapsoOutboundTransport({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      fetchImpl: fn,
    });
    await expect(send(ctx("12345-678@g.us", "hi"))).rejects.toThrow(/unsupported target/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("★ suppresses a proactive send to an opted-out peer WITHOUT calling fetch (TCPA)", async () => {
    const store = memStore(["+15557654321"]); // opted out (SMS-style +E164 key)
    const { fn } = okFetch();
    const send = createKapsoOutboundTransport({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      fetchImpl: fn,
      logger: { warn: () => {} },
    });
    const res = await send(ctx("15557654321@s.whatsapp.net", "nudge"));
    expect(res.meta?.suppressed).toBe(true);
    expect(res.messageId).toBe(KAPSO_OUTBOUND_SUPPRESSED);
    expect(fn).not.toHaveBeenCalled();
  });

  it("★ fail-closed: opt-out store throw → throws, no send", async () => {
    const store: OptOutStore = {
      isOptedOut: () => {
        throw new Error("store down");
      },
      optOut: () => {},
      optIn: () => {},
    };
    const { fn } = okFetch();
    const send = createKapsoOutboundTransport({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      fetchImpl: fn,
    });
    await expect(send(ctx("15557654321@s.whatsapp.net", "nudge"))).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws when config is unavailable or the phone-number-id is unresolved", async () => {
    const store = memStore();
    const { fn } = okFetch();
    const noCfg = createKapsoOutboundTransport({
      resolveConfig: () => null,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      fetchImpl: fn,
    });
    await expect(noCfg(ctx("x@s.whatsapp.net", "hi"))).rejects.toThrow();
    const noPnid = createKapsoOutboundTransport({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => null,
      store,
      fetchImpl: fn,
    });
    await expect(noPnid(ctx("x@s.whatsapp.net", "hi"))).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("★ propagates a Cloud API send failure as a throw", async () => {
    const store = memStore();
    const failFetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }),
    ) as unknown as typeof fetch;
    const send = createKapsoOutboundTransport({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      fetchImpl: failFetch,
    });
    await expect(send(ctx("15557654321@s.whatsapp.net", "nudge"))).rejects.toThrow(/send failed/);
    expect(failFetch).toHaveBeenCalledTimes(1); // reached the send, not a short-circuit
  });
});
