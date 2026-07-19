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
import { parseKapsoInbounds } from "./kapso-webhook.js";

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
// Peers arrive already-normalized to +E164 (the webhook parse boundary does it).
const PEER = "+15557654321";
const PEER2 = "+15550000000";

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

/** A fetch that always returns a Cloud API error (drives the send-failure path). */
function failingFetch(status = 400) {
  return vi.fn(async () => {
    return new Response(JSON.stringify({ error: { message: "bad request" } }), { status });
  }) as unknown as typeof fetch;
}

function recordingLogger() {
  const warn: string[] = [];
  const error: string[] = [];
  return {
    logger: { warn: (m: string) => warn.push(m), error: (m: string) => error.push(m) },
    warn,
    error,
  };
}

describe("handleKapsoInbound — compliance-first + mandated acks (Kapso send)", () => {
  it("★ STOP persists opt-out AND still sends the confirmation (unguarded); not routed", async () => {
    const store = memStore();
    const { fn, bodies } = recordingFetch();
    const dispatch = vi.fn(async () => {});
    const kind = await handleKapsoInbound({
      inbound: { from: PEER, body: "STOP" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: PN,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(kind).toBe("stop");
    expect(store.set.has(PEER)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bodies[0].toLowerCase()).toContain("unsubscribed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("★ START clears the opt-out AND sends the opt-in ack (opt-in path)", async () => {
    const store = memStore([PEER]); // currently opted-out
    const { fn, bodies } = recordingFetch();
    const dispatch = vi.fn(async () => {});
    const kind = await handleKapsoInbound({
      inbound: { from: PEER, body: "START" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: PN,
      store,
      fetchImpl: fn,
      dispatch,
    });
    expect(kind).toBe("start");
    expect(store.set.has(PEER)).toBe(false); // opt-out cleared
    expect(fn).toHaveBeenCalledTimes(1); // ack sent
    // the opt-in ack, not the STOP copy — a wrong-template regression would fail here
    expect(bodies[0].toLowerCase()).toContain("subscrib");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("HELP from an already-opted-out number still sends (not suppressed)", async () => {
    const store = memStore([PEER]);
    const { fn } = recordingFetch();
    const kind = await handleKapsoInbound({
      inbound: { from: PEER, body: "HELP" },
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
      inbound: { from: PEER, body: "log an apple" },
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
        inbound: { from: PEER2, body: "hi" },
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
        inbound: { from: PEER2, body: "STOP" },
        cfg: CFG,
        config,
        phoneNumberId: PN,
        store,
        fetchImpl: fn,
        dispatch,
      }),
    ).toBe("stop");
    expect(store.set.has(PEER2)).toBe(true);
  });

  it("★ QG M4 — a null phone-number-id still RECORDS a STOP (ack skipped, warned)", async () => {
    const store = memStore();
    const { fn } = recordingFetch();
    const { logger, warn } = recordingLogger();
    const kind = await handleKapsoInbound({
      inbound: { from: PEER, body: "STOP" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: null, // unresolved send target
      store,
      fetchImpl: fn,
      logger,
      dispatch: vi.fn(async () => {}),
    });
    expect(kind).toBe("stop");
    expect(store.set.has(PEER)).toBe(true); // opt-out recorded despite no send target
    expect(fn).not.toHaveBeenCalled(); // ack could not be sent
    expect(warn.some((m) => m.includes("ack NOT sent"))).toBe(true);
  });

  it("QG M4 — a null phone-number-id blocks (does not dispatch) an ordinary allowed message", async () => {
    const store = memStore();
    const dispatch = vi.fn(async () => {});
    const { logger, warn } = recordingLogger();
    const kind = await handleKapsoInbound({
      inbound: { from: PEER, body: "log an apple" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: null,
      store,
      logger,
      dispatch,
    });
    expect(kind).toBe("blocked");
    expect(dispatch).not.toHaveBeenCalled();
    expect(warn.some((m) => m.includes("agent dispatch skipped"))).toBe(true);
  });

  it("★ QG M2 — a failed mandated compliance ack is logged, not swallowed", async () => {
    const store = memStore();
    const fn = failingFetch(400);
    const { logger, error } = recordingLogger();
    const kind = await handleKapsoInbound({
      inbound: { from: PEER, body: "STOP" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: PN,
      store,
      fetchImpl: fn,
      logger,
      dispatch: vi.fn(async () => {}),
    });
    expect(kind).toBe("stop");
    expect(store.set.has(PEER)).toBe(true); // opt-out still recorded
    expect(error.some((m) => m.includes("compliance ack send failed"))).toBe(true);
  });

  it("★ a compliance-store WRITE failure PROPAGATES (so the webhook 5xx/retries — STOP not lost)", async () => {
    // store.optOut throwing = the durable opt-out write failed; it MUST bubble so the
    // webhook responds 5xx and Meta redelivers, rather than being acked-and-dropped.
    const store: OptOutStore = {
      isOptedOut: () => false,
      optOut: () => {
        throw new Error("pg write failed");
      },
      optIn: () => {},
    };
    await expect(
      handleKapsoInbound({
        inbound: { from: PEER, body: "STOP" },
        cfg: CFG,
        config: BASE,
        phoneNumberId: PN,
        store,
        dispatch: vi.fn(async () => {}),
      }),
    ).rejects.toThrow();
  });

  it("★ an AGENT-DISPATCH failure is swallowed+logged (webhook still 200 — not retry-worthy)", async () => {
    const store = memStore();
    const { logger, error } = recordingLogger();
    const dispatch = vi.fn(async () => {
      throw new Error("agent boom");
    });
    const kind = await handleKapsoInbound({
      inbound: { from: PEER, body: "log an apple" },
      cfg: CFG,
      config: BASE,
      phoneNumberId: PN,
      store,
      logger,
      dispatch,
    });
    expect(kind).toBe("agent"); // did NOT throw
    expect(error.some((m) => m.includes("agent dispatch failed"))).toBe(true);
  });
});

describe("kapsoInboundAllowed", () => {
  it("disabled→false, pairing→true, allowlist→only +E164 allowFrom", () => {
    expect(kapsoInboundAllowed({ ...BASE, inbound: "disabled" }, PEER)).toBe(false);
    expect(kapsoInboundAllowed({ ...BASE, inbound: "pairing" }, PEER)).toBe(true);
    const al = { ...BASE, inbound: "allowlist" as const, allowFrom: [PEER] };
    expect(kapsoInboundAllowed(al, PEER)).toBe(true);
    expect(kapsoInboundAllowed(al, PEER2)).toBe(false);
  });
});

describe("guardedSendKapso / createKapsoReplyDeliver — agent replies opt-out-guarded", () => {
  it("★ sends to a NON-opted peer exactly once and reports ok (positive path — guards a suppress-all regression)", async () => {
    const store = memStore();
    const { fn, bodies } = recordingFetch();
    const r = await guardedSendKapso({
      config: BASE,
      phoneNumberId: PN,
      to: PEER,
      body: "your nudge",
      store,
      fetchImpl: fn,
    });
    expect(r).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toBe("your nudge");
  });

  it("suppresses a send to an opted-out peer WITHOUT calling fetch", async () => {
    const store = memStore([PEER]);
    const { fn } = recordingFetch();
    const r = await guardedSendKapso({
      config: BASE,
      phoneNumberId: PN,
      to: PEER,
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
      to: PEER,
      body: "nudge",
      store,
      fetchImpl: fn,
    });
    expect(r).toEqual({ ok: false, suppressed: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("★ QG M2 — a non-suppressed send FAILURE is logged and reported ok:false", async () => {
    const store = memStore();
    const fn = failingFetch(500);
    const { logger, warn } = recordingLogger();
    const r = await guardedSendKapso({
      config: BASE,
      phoneNumberId: PN,
      to: PEER,
      body: "nudge",
      store,
      fetchImpl: fn,
      logger,
    });
    expect(r).toEqual({ ok: false });
    expect(warn.some((m) => m.includes("agent-reply send failed"))).toBe(true);
  });

  it("an agent reply to an opted-out peer sends ZERO messages (pin #1)", async () => {
    const store = memStore([PEER]);
    const { fn } = recordingFetch();
    const deliver = createKapsoReplyDeliver({
      config: BASE,
      phoneNumberId: PN,
      to: PEER,
      store,
      fetchImpl: fn,
    });
    await deliver({ text: "here is your answer" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("★ cross-channel keyspace: an SMS-style +E164 opt-out suppresses a BARE-digit Kapso send (end-to-end)", async () => {
    // The "one opt-out keyspace across SMS + WhatsApp" guarantee, exercised through
    // the real normalization boundary: a STOP recorded via SMS is keyed "+16505551234";
    // Meta delivers the same peer as bare "16505551234"; after parseKapsoInbounds
    // normalizes it, the guarded send must find the opt-out and suppress.
    const store = memStore(["+16505551234"]); // seeded as if by an SMS STOP
    const payload = {
      entry: [
        {
          changes: [
            {
              value: { messages: [{ from: "16505551234", id: "wamid.x", text: { body: "hi" } }] },
            },
          ],
        },
      ],
    };
    const [inbound] = parseKapsoInbounds(payload);
    expect(inbound.from).toBe("+16505551234"); // normalized at the boundary
    const { fn } = recordingFetch();
    const r = await guardedSendKapso({
      config: BASE,
      phoneNumberId: PN,
      to: inbound.from,
      body: "nudge",
      store,
      fetchImpl: fn,
    });
    expect(r).toEqual({ ok: false, suppressed: true }); // cross-channel opt-out honored
    expect(fn).not.toHaveBeenCalled();
  });

  it("an agent reply to a NON-opted peer sends exactly once (positive deliver path)", async () => {
    const store = memStore();
    const { fn } = recordingFetch();
    const deliver = createKapsoReplyDeliver({
      config: BASE,
      phoneNumberId: PN,
      to: PEER,
      store,
      fetchImpl: fn,
    });
    await deliver({ text: "here is your answer" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
