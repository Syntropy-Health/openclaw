import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { type OptOutStore } from "../../twilio/src/compliance.js";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import {
  createKapsoReplyDeliver,
  guardedSendKapso,
  handleKapsoInbound,
  kapsoInboundAllowed,
} from "./kapso-inbound.js";

const BASE: ResolvedKapsoConfig = {
  apiKey: "k",
  baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
  phoneNumberId: "PN_1",
  appSecret: "s",
  inbound: "pairing",
  allowFrom: [],
};
const CFG = {} as OpenClawConfig; // consumed only by the real dispatch (mocked here)
const PN = "PN_1";

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
  const bodies: string[] = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { text?: { body?: string } };
    bodies.push(payload.text?.body ?? "");
    return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

describe("handleKapsoInbound — compliance-first + mandated acks (Kapso send)", () => {
  it("★ STOP persists opt-out AND still sends the confirmation (unguarded); not routed", async () => {
    const store = memStore();
    const { fn, bodies } = recordingFetch();
    const dispatch = vi.fn(async () => {});
    const kind = await handleKapsoInbound({
      inbound: { from: "15557654321", body: "STOP" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: PN,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(kind).toBe("stop");
    expect(store.set.has("15557654321")).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bodies[0].toLowerCase()).toContain("unsubscribed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("HELP from an already-opted-out number still sends (not suppressed)", async () => {
    const store = memStore(["15557654321"]);
    const { fn } = recordingFetch();
    const kind = await handleKapsoInbound({
      inbound: { from: "15557654321", body: "HELP" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: PN,
      store,
      fetchImpl: fn,
      dispatch: vi.fn(async () => {}),
    });
    expect(kind).toBe("help");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a normal message routes to the agent (dispatch called, no compliance send)", async () => {
    const store = memStore();
    const { fn } = recordingFetch();
    const dispatch = vi.fn(async () => {});
    const kind = await handleKapsoInbound({
      inbound: { from: "15557654321", body: "log an apple" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: PN,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(kind).toBe("agent");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("inbound:disabled drops ordinary messages (blocked) but STILL honors STOP", async () => {
    const config = { ...BASE, inbound: "disabled" as const };
    const store = memStore();
    const dispatch = vi.fn(async () => {});
    const { fn } = recordingFetch();
    expect(
      await handleKapsoInbound({
        inbound: { from: "15550000000", body: "hi" },
        cfg: CFG,
        config,
        phoneNumberId: PN,
        store,
        fetchImpl: fn,
        dispatch,
      }),
    ).toBe("blocked");
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await handleKapsoInbound({
        inbound: { from: "15550000000", body: "STOP" },
        cfg: CFG,
        config,
        phoneNumberId: PN,
        store,
        fetchImpl: fn,
        dispatch,
      }),
    ).toBe("stop");
    expect(store.set.has("15550000000")).toBe(true);
  });
});

describe("kapsoInboundAllowed", () => {
  it("disabled→false, pairing→true, allowlist→only allowFrom", () => {
    expect(kapsoInboundAllowed({ ...BASE, inbound: "disabled" }, "15557654321")).toBe(false);
    expect(kapsoInboundAllowed({ ...BASE, inbound: "pairing" }, "15557654321")).toBe(true);
    const al = { ...BASE, inbound: "allowlist" as const, allowFrom: ["15557654321"] };
    expect(kapsoInboundAllowed(al, "15557654321")).toBe(true);
    expect(kapsoInboundAllowed(al, "15550000000")).toBe(false);
  });
});

describe("guardedSendKapso / createKapsoReplyDeliver — agent replies opt-out-guarded", () => {
  it("suppresses a send to an opted-out peer WITHOUT calling fetch", async () => {
    const store = memStore(["15557654321"]);
    const { fn } = recordingFetch();
    const r = await guardedSendKapso({
      config: BASE,
      phoneNumberId: PN,
      to: "15557654321",
      body: "nudge",
      store,
      fetchImpl: fn,
    });
    expect(r).toEqual({ ok: false, suppressed: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("fail-closed: store throw → suppressed (no send)", async () => {
    const store: OptOutStore = {
      isOptedOut: () => {
        throw new Error("down");
      },
      optOut: () => {},
      optIn: () => {},
    };
    const { fn } = recordingFetch();
    const r = await guardedSendKapso({
      config: BASE,
      phoneNumberId: PN,
      to: "15557654321",
      body: "nudge",
      store,
      fetchImpl: fn,
    });
    expect(r).toEqual({ ok: false, suppressed: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("an agent reply to an opted-out peer sends ZERO messages (pin #1)", async () => {
    const store = memStore(["15557654321"]);
    const { fn } = recordingFetch();
    const deliver = createKapsoReplyDeliver({
      config: BASE,
      phoneNumberId: PN,
      to: "15557654321",
      store,
      fetchImpl: fn,
    });
    await deliver({ text: "here is your answer" });
    expect(fn).not.toHaveBeenCalled();
  });
});
