import { describe, expect, it, vi } from "vitest";
import { type OptOutStore } from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { buildSmsOutboundAdapter, SMS_OPTOUT_SUPPRESSED } from "./outbound.js";

const CONFIG: ResolvedTwilioSmsConfig = {
  accountSid: "AC_x",
  apiKeySid: "SK_x",
  apiKeySecret: "secret_never_leak",
  authToken: "authtok",
  smsNumber: "+15550001234",
  inbound: "pairing",
  allowFrom: [],
};

const emptyStore: OptOutStore = { isOptedOut: () => false, optOut: () => {}, optIn: () => {} };

// Minimal ChannelOutboundContext — only cfg/to/text are read by the adapter.
function ctx(to: string, text: string) {
  return { cfg: {}, to, text } as never;
}

function okFetch(payload: Record<string, unknown>) {
  return vi.fn(
    async () => new Response(JSON.stringify(payload), { status: 201 }),
  ) as unknown as typeof fetch;
}

describe("buildSmsOutboundAdapter", () => {
  it("is a direct-delivery adapter", () => {
    const a = buildSmsOutboundAdapter({ resolveConfig: () => CONFIG, store: emptyStore });
    expect(a.deliveryMode).toBe("direct");
  });

  it("sendText success → { channel: 'sms', messageId: sid }", async () => {
    const a = buildSmsOutboundAdapter({
      resolveConfig: () => CONFIG,
      store: emptyStore,
      fetchImpl: okFetch({ sid: "SM99", status: "queued" }),
    });
    const r = await a.sendText!(ctx("+15557654321", "nudge"));
    expect(r.channel).toBe("sms");
    expect(r.messageId).toBe("SM99");
  });

  it("★ opt-out suppression returns a TERMINAL sentinel (no throw, no retry)", async () => {
    const optedStore: OptOutStore = { isOptedOut: () => true, optOut: () => {}, optIn: () => {} };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const a = buildSmsOutboundAdapter({
      resolveConfig: () => CONFIG,
      store: optedStore,
      fetchImpl,
    });
    const r = await a.sendText!(ctx("+15557654321", "nudge"));
    expect(r.messageId).toBe(SMS_OPTOUT_SUPPRESSED);
    expect(r.meta).toMatchObject({ suppressed: true });
    expect(fetchImpl).not.toHaveBeenCalled(); // never sent
  });

  it("a genuine send failure THROWS (retryable path)", async () => {
    const failFetch = vi.fn(
      async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    ) as unknown as typeof fetch;
    const a = buildSmsOutboundAdapter({
      resolveConfig: () => CONFIG,
      store: emptyStore,
      fetchImpl: failFetch,
    });
    await expect(a.sendText!(ctx("+15557654321", "nudge"))).rejects.toThrow(/sms send failed/i);
  });

  it("throws when the channel is not configured (resolveConfig → null)", async () => {
    const a = buildSmsOutboundAdapter({ resolveConfig: () => null, store: emptyStore });
    await expect(a.sendText!(ctx("+15557654321", "nudge"))).rejects.toThrow(/not configured/i);
  });

  it("surfaces the status + Twilio message on failure but NEVER the api-key secret", async () => {
    // Load-bearing: a body that WOULD expose a leak if the error interpolated
    // request/auth — assert real diagnostic info is present AND the secret is not.
    const failFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 21211, message: "Invalid 'To'" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const a = buildSmsOutboundAdapter({
      resolveConfig: () => CONFIG,
      store: emptyStore,
      fetchImpl: failFetch,
    });
    let caught: unknown;
    try {
      await a.sendText!(ctx("+15557654321", "nudge"));
    } catch (e) {
      caught = e;
    }
    const msg = String(caught);
    expect(msg).toContain("400"); // real diagnostic info surfaced (not tautological)
    expect(msg).toContain("Invalid 'To'");
    expect(msg).not.toContain("secret_never_leak"); // ...but never the api-key secret
  });
});
