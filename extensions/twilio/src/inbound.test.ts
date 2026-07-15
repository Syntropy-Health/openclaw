import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { type OptOutStore } from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { createSmsReplyDeliver, handleInboundSms, inboundAllowed } from "./inbound.js";

const BASE: ResolvedTwilioSmsConfig = {
  accountSid: "AC_x",
  apiKeySid: "SK_x",
  apiKeySecret: "secret_x",
  authToken: "authtok",
  smsNumber: "+15550001234",
  inbound: "pairing",
  allowFrom: [],
};

const CFG = {} as OpenClawConfig; // only consumed by the real dispatch, which is mocked here

function memStore(seed: string[] = []): OptOutStore & { set: Set<string> } {
  const set = new Set(seed);
  return {
    set,
    isOptedOut: (n) => set.has(n),
    optOut: (n) => void set.add(n),
    optIn: (n) => void set.delete(n),
  };
}

function recordingFetch() {
  const calls: Array<{ to: string; body: string }> = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const p = init.body as URLSearchParams;
    calls.push({ to: p.get("To") ?? "", body: p.get("Body") ?? "" });
    return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("handleInboundSms — compliance-first + mandated acks", () => {
  it("★ STOP persists the opt-out AND still sends the confirmation (unguarded mandated ack)", async () => {
    const store = memStore();
    const { fn, calls } = recordingFetch();
    const dispatch = vi.fn(async () => {});
    const kind = await handleInboundSms({
      inbound: { from: "+15557654321", body: "STOP" },
      cfg: CFG,
      config: BASE,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(kind).toBe("stop");
    expect(store.set.has("+15557654321")).toBe(true); // opted out
    expect(fn).toHaveBeenCalledTimes(1); // confirmation SENT despite the just-recorded opt-out
    expect(calls[0].to).toBe("+15557654321");
    expect(calls[0].body.toLowerCase()).toContain("unsubscribed");
    expect(dispatch).not.toHaveBeenCalled(); // never reaches the agent
  });

  it("HELP from an ALREADY-opted-out number still sends the HELP copy (not suppressed)", async () => {
    const store = memStore(["+15557654321"]);
    const { fn } = recordingFetch();
    const kind = await handleInboundSms({
      inbound: { from: "+15557654321", body: "HELP" },
      cfg: CFG,
      config: BASE,
      store,
      fetchImpl: fn,
      dispatch: vi.fn(async () => {}),
    });
    expect(kind).toBe("help");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("START clears the opt-out and sends the resubscribe ack", async () => {
    const store = memStore(["+15557654321"]);
    const { fn } = recordingFetch();
    const kind = await handleInboundSms({
      inbound: { from: "+15557654321", body: "start" },
      cfg: CFG,
      config: BASE,
      store,
      fetchImpl: fn,
      dispatch: vi.fn(async () => {}),
    });
    expect(kind).toBe("start");
    expect(store.set.has("+15557654321")).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a normal message routes to the agent (dispatch called, no compliance send)", async () => {
    const store = memStore();
    const { fn } = recordingFetch();
    const dispatch = vi.fn(async () => {});
    const kind = await handleInboundSms({
      inbound: { from: "+15557654321", body: "log an apple" },
      cfg: CFG,
      config: BASE,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(kind).toBe("agent");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("inboundAllowed — access policy", () => {
  it("disabled → false; pairing → true", () => {
    expect(inboundAllowed({ ...BASE, inbound: "disabled" }, "+15557654321")).toBe(false);
    expect(inboundAllowed({ ...BASE, inbound: "pairing" }, "+15557654321")).toBe(true);
  });
  it("allowlist → only allowFrom entries", () => {
    const c = { ...BASE, inbound: "allowlist" as const, allowFrom: ["+15557654321"] };
    expect(inboundAllowed(c, "+15557654321")).toBe(true);
    expect(inboundAllowed(c, "+15550000000")).toBe(false);
  });
});

describe("handleInboundSms — policy enforcement (with STOP always honored)", () => {
  it("inbound:disabled drops ordinary messages (blocked, no dispatch) but STILL honors STOP", async () => {
    const config = { ...BASE, inbound: "disabled" as const };
    const store = memStore();
    const dispatch = vi.fn(async () => {});
    const { fn } = recordingFetch();

    const ordinary = await handleInboundSms({
      inbound: { from: "+15557654321", body: "hi" },
      cfg: CFG,
      config,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(ordinary).toBe("blocked");
    expect(dispatch).not.toHaveBeenCalled();

    const stop = await handleInboundSms({
      inbound: { from: "+15557654321", body: "STOP" },
      cfg: CFG,
      config,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(stop).toBe("stop"); // compliance honored even when inbound disabled
    expect(store.set.has("+15557654321")).toBe(true);
  });

  it("inbound:allowlist routes only allowlisted numbers", async () => {
    const config = { ...BASE, inbound: "allowlist" as const, allowFrom: ["+15557654321"] };
    const store = memStore();
    const dispatch = vi.fn(async () => {});
    expect(
      await handleInboundSms({
        inbound: { from: "+15550000000", body: "hi" },
        cfg: CFG,
        config,
        store,
        dispatch,
      }),
    ).toBe("blocked");
    expect(
      await handleInboundSms({
        inbound: { from: "+15557654321", body: "hi" },
        cfg: CFG,
        config,
        store,
        dispatch,
      }),
    ).toBe("agent");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("createSmsReplyDeliver — agent replies ARE opt-out-guarded (pin #1 at the reply seam)", () => {
  it("an opted-out peer receives ZERO agent-reply sends", async () => {
    const store = memStore(["+15557654321"]);
    const { fn } = recordingFetch();
    const deliver = createSmsReplyDeliver({
      config: BASE,
      to: "+15557654321",
      store,
      fetchImpl: fn,
    });
    await deliver({ text: "here is your answer" });
    expect(fn).not.toHaveBeenCalled();
  });
  it("a non-opted peer receives the agent reply", async () => {
    const store = memStore();
    const { fn } = recordingFetch();
    const deliver = createSmsReplyDeliver({
      config: BASE,
      to: "+15557654321",
      store,
      fetchImpl: fn,
    });
    await deliver({ text: "hi" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
