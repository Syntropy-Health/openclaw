import { describe, expect, it, vi } from "vitest";
import {
  classifyCompliance,
  guardedSendSms,
  handleInboundCompliance,
  type OptOutStore,
} from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";

const CONFIG: ResolvedTwilioSmsConfig = {
  accountSid: "AC_x",
  apiKeySid: "SK_x",
  apiKeySecret: "secret_never_leak",
  authToken: "authtok",
  smsNumber: "+15550001234",
  inbound: "pairing",
  allowFrom: [],
};

/** In-memory opt-out store for tests. */
function memStore(seed: string[] = []): OptOutStore & { set: Set<string> } {
  const set = new Set(seed);
  return {
    set,
    isOptedOut: (n) => set.has(n),
    optOut: (n) => void set.add(n),
    optIn: (n) => void set.delete(n),
  };
}

describe("classifyCompliance — exact-keyword match (no false opt-out from conversation)", () => {
  it("maps Twilio opt-out keywords to 'stop' (case-insensitive, trimmed, trailing punctuation)", () => {
    for (const k of [
      "STOP",
      "stop",
      " Stop ",
      "STOP.",
      "UNSUBSCRIBE",
      "cancel",
      "QUIT",
      "END",
      "STOPALL",
    ]) {
      expect(classifyCompliance(k), k).toBe("stop");
    }
  });
  it("maps opt-in keywords to 'start'", () => {
    for (const k of ["START", "start", "YES", "unstop"])
      expect(classifyCompliance(k), k).toBe("start");
  });
  it("maps help keywords to 'help'", () => {
    for (const k of ["HELP", "info"]) expect(classifyCompliance(k), k).toBe("help");
  });
  it("does NOT classify conversational text containing a keyword as a substring", () => {
    for (const m of [
      "I don't want to stop using this",
      "please help me log an apple",
      "start my day",
    ]) {
      expect(classifyCompliance(m), m).toBeNull();
    }
  });
});

describe("handleInboundCompliance", () => {
  it("STOP persists an opt-out and returns a confirmation (kind=stop)", async () => {
    const store = memStore();
    const out = await handleInboundCompliance("+15557654321", "STOP", store);
    expect(out.kind).toBe("stop");
    expect(store.set.has("+15557654321")).toBe(true);
    if (out.kind === "stop") expect(out.reply.length).toBeGreaterThan(0);
  });

  it("START clears an existing opt-out (kind=start)", async () => {
    const store = memStore(["+15557654321"]);
    const out = await handleInboundCompliance("+15557654321", "start", store);
    expect(out.kind).toBe("start");
    expect(store.set.has("+15557654321")).toBe(false);
  });

  it("HELP returns help copy WITHOUT changing opt-out state", async () => {
    const store = memStore(["+15557654321"]);
    const out = await handleInboundCompliance("+15557654321", "HELP", store);
    expect(out.kind).toBe("help");
    expect(store.set.has("+15557654321")).toBe(true); // unchanged
  });

  it("a normal message passes through to the agent (kind=passthrough)", async () => {
    const store = memStore();
    const out = await handleInboundCompliance("+15557654321", "log an apple", store);
    expect(out.kind).toBe("passthrough");
  });

  it("compliance replies never contain PHI markers (generic copy only)", async () => {
    const store = memStore();
    const stop = await handleInboundCompliance("+15557654321", "STOP", store);
    const help = await handleInboundCompliance("+15557654321", "HELP", store);
    for (const o of [stop, help]) {
      if (o.kind !== "passthrough") {
        expect(o.reply).not.toMatch(/clerk|pairing|\bphi\b|patient/i);
      }
    }
  });
});

describe("★ BEHAVIORAL PIN — a STOP'd number receives ZERO subsequent sends", () => {
  it("suppresses a send to an opted-out number WITHOUT calling fetch (0 network sends)", async () => {
    const store = memStore();
    await handleInboundCompliance("+15557654321", "STOP", store);

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await guardedSendSms(
      { config: CONFIG, to: "+15557654321", body: "nudge", fetchImpl },
      store,
    );
    expect(r).toEqual({ ok: false, suppressed: true });
    expect(fetchImpl).not.toHaveBeenCalled(); // ZERO sends — the pin
  });

  it("allows a send to a number that is NOT opted out", async () => {
    const store = memStore();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 }),
    ) as unknown as typeof fetch;
    const r = await guardedSendSms(
      { config: CONFIG, to: "+15557654321", body: "nudge", fetchImpl },
      store,
    );
    expect(r).toEqual({ ok: true, sid: "SM1", status: "queued" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: if the opt-out store THROWS, the send is suppressed (never sent)", async () => {
    const throwingStore: OptOutStore = {
      isOptedOut: () => {
        throw new Error("store down");
      },
      optOut: () => {},
      optIn: () => {},
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await guardedSendSms(
      { config: CONFIG, to: "+15557654321", body: "nudge", fetchImpl },
      throwingStore,
    );
    expect(r).toEqual({ ok: false, suppressed: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
