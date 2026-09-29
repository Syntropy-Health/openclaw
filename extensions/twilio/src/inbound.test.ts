import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { HELP_REPLY, OPT_IN_REPLY, OPT_OUT_REPLY, type OptOutStore } from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { type SmsContactStore } from "./contacts-store.js";
import {
  createSmsReplyDeliver,
  handleInboundSms,
  inboundAllowed,
  type HandleInboundDeps,
} from "./inbound.js";

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

/** Every number already confirmed — keeps pre-existing tests on the agent path only. */
function seenContacts(): SmsContactStore {
  return { recordFirstContact: () => false, forgetContact: () => {}, hasContact: () => true };
}

/** A real in-memory first-contact record. */
function memContacts(seed: string[] = []): SmsContactStore & { set: Set<string> } {
  const set = new Set(seed);
  return {
    set,
    recordFirstContact: (n) => {
      if (set.has(n)) return false;
      set.add(n);
      return true;
    },
    forgetContact: (n) => void set.delete(n),
    hasContact: (n) => set.has(n),
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
      contacts: seenContacts(),
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
      contacts: seenContacts(),
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
      contacts: seenContacts(),
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
      contacts: seenContacts(),
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
      contacts: seenContacts(),
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
      contacts: seenContacts(),
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
        contacts: seenContacts(),
        dispatch,
      }),
    ).toBe("blocked");
    expect(
      await handleInboundSms({
        inbound: { from: "+15557654321", body: "hi" },
        cfg: CFG,
        config,
        store,
        contacts: seenContacts(),
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

describe("ShrineAI sign-off on the INBOUND reply path (the main conversational path)", () => {
  // QG (2026-09-29): the sign-off was first wired only into the outbound adapter
  // (sendText), which agent REPLIES to an inbound SMS never use — so a user who
  // texted in got an unsigned AI answer. These pin the Body Twilio receives.
  it("the agent's reply to an inbound SMS is signed as ShrineAI", async () => {
    const { fn, calls } = recordingFetch();
    const deliver = createSmsReplyDeliver({
      config: BASE,
      to: "+15557654321",
      store: memStore(),
      fetchImpl: fn,
    });
    await deliver({ text: "Your check-in is logged." });
    expect(calls[0].body).toBe("Your check-in is logged. - ShrineAI, an AI assistant");
  });

  it("a long agent reply is fitted to 1600 chars with the sign-off kept (Twilio rejects longer)", async () => {
    const { fn, calls } = recordingFetch();
    const deliver = createSmsReplyDeliver({
      config: BASE,
      to: "+15557654321",
      store: memStore(),
      fetchImpl: fn,
    });
    await deliver({ text: "x".repeat(4000) });
    expect(calls[0].body.length).toBe(1600);
    expect(calls[0].body.startsWith("x")).toBe(true);
    expect(calls[0].body.endsWith(" - ShrineAI, an AI assistant")).toBe(true);
  });

  it.each(["STOP", "START", "HELP"])(
    "the mandated %s acknowledgement is NOT signed (TCPA copy stays exact)",
    async (keyword) => {
      const { fn, calls } = recordingFetch();
      await handleInboundSms({
        inbound: { from: "+15557654321", body: keyword },
        cfg: CFG,
        config: BASE,
        store: memStore(),
        contacts: seenContacts(),
        fetchImpl: fn,
        dispatch: vi.fn(async () => {}),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body).not.toContain("- ShrineAI, an AI assistant");
      // What Twilio receives is the registered campaign copy, byte-for-byte.
      const expected = { STOP: OPT_OUT_REPLY, START: OPT_IN_REPLY, HELP: HELP_REPLY }[keyword];
      expect(calls[0].body).toBe(expected);
    },
  );
});

describe("mobile-originated opt-in — the first message IS the opt-in (registered campaign)", () => {
  const FROM = "+15557654321";
  async function send(
    body: string,
    deps: {
      store: ReturnType<typeof memStore>;
      contacts: SmsContactStore;
      fn: typeof fetch;
      dispatch: ReturnType<typeof vi.fn>;
      config?: ResolvedTwilioSmsConfig;
      logger?: { warn: (m: string) => void };
    },
  ) {
    return handleInboundSms({
      inbound: { from: FROM, body },
      cfg: CFG,
      config: deps.config ?? BASE,
      store: deps.store,
      contacts: deps.contacts,
      logger: deps.logger,
      fetchImpl: deps.fn,
      dispatch: deps.dispatch as unknown as HandleInboundDeps["dispatch"],
    });
  }

  it("a first ordinary message gets OPT_IN_REPLY (unsigned, exact) BEFORE the agent runs", async () => {
    const { fn, calls } = recordingFetch();
    const order: string[] = [];
    const dispatch = vi.fn(async () => {
      order.push(`agent after ${calls.length} send(s)`);
    });
    const out = await send("hi", { store: memStore(), contacts: memContacts(), fn, dispatch });
    expect(out).toBe("agent");
    expect(calls).toEqual([{ to: FROM, body: OPT_IN_REPLY }]);
    expect(order).toEqual(["agent after 1 send(s)"]);
  });

  it("the second message is NOT re-confirmed", async () => {
    const { fn, calls } = recordingFetch();
    const deps = {
      store: memStore(),
      contacts: memContacts(),
      fn,
      dispatch: vi.fn(async () => {}),
    };
    await send("hi", deps);
    await send("and another", deps);
    expect(calls.filter((c) => c.body === OPT_IN_REPLY)).toHaveLength(1);
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
  });

  it("START then an ordinary message confirms the opt-in exactly ONCE", async () => {
    const { fn, calls } = recordingFetch();
    const deps = {
      store: memStore(),
      contacts: memContacts(),
      fn,
      dispatch: vi.fn(async () => {}),
    };
    await send("START", deps);
    await send("hi", deps);
    expect(calls.filter((c) => c.body === OPT_IN_REPLY)).toHaveLength(1);
  });

  it("HELP first does not consume the opt-in: the following ordinary message is confirmed", async () => {
    const { fn, calls } = recordingFetch();
    const deps = {
      store: memStore(),
      contacts: memContacts(),
      fn,
      dispatch: vi.fn(async () => {}),
    };
    await send("HELP", deps);
    await send("hi", deps);
    expect(calls.map((c) => c.body)).toEqual([HELP_REPLY, OPT_IN_REPLY]);
  });

  it("a number the policy blocks gets no confirmation and is not recorded", async () => {
    const { fn, calls } = recordingFetch();
    const contacts = memContacts();
    const out = await send("hi", {
      store: memStore(),
      contacts,
      fn,
      dispatch: vi.fn(async () => {}),
      config: { ...BASE, inbound: "disabled" },
    });
    expect(out).toBe("blocked");
    expect(calls).toHaveLength(0);
    expect(contacts.set.has(FROM)).toBe(false);
  });

  it("★ a number already on the opt-out list receives NO confirmation (guarded send)", async () => {
    const { fn, calls } = recordingFetch();
    await send("hi", {
      store: memStore([FROM]),
      contacts: memContacts(),
      fn,
      dispatch: vi.fn(async () => {}),
    });
    expect(calls).toHaveLength(0);
  });

  it("a first-contact store ERROR sends the confirmation (a duplicate beats a miss) and warns", async () => {
    const { fn, calls } = recordingFetch();
    const warn = vi.fn();
    const broken: SmsContactStore = {
      recordFirstContact: () => {
        throw new Error("db down");
      },
      forgetContact: () => {},
      hasContact: () => false,
    };
    await send("hi", {
      store: memStore(),
      contacts: broken,
      fn,
      dispatch: vi.fn(async () => {}),
      logger: { warn },
    });
    expect(calls).toEqual([{ to: FROM, body: OPT_IN_REPLY }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("review fixes — opted-out numbers, undelivered confirmations", () => {
  const FROM = "+15557654321";
  function failingFetch() {
    const calls: string[] = [];
    const fn = vi.fn(async (_u: string, init: RequestInit) => {
      calls.push((init.body as URLSearchParams).get("Body") ?? "");
      return new Response(JSON.stringify({ message: "busy" }), { status: 503 });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it("an opted-out number gets NO agent turn (and nothing is sent)", async () => {
    const { fn, calls } = recordingFetch();
    const dispatch = vi.fn(async () => {});
    const out = await handleInboundSms({
      inbound: { from: FROM, body: "hello?" },
      cfg: CFG,
      config: BASE,
      store: memStore([FROM]),
      contacts: memContacts(),
      fetchImpl: fn,
      dispatch,
    });
    expect(out).toBe("opted_out");
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("an opt-out store ERROR also skips the agent turn (replies would fail closed anyway)", async () => {
    const dispatch = vi.fn(async () => {});
    const broken: OptOutStore = {
      isOptedOut: () => {
        throw new Error("db down");
      },
      optOut: () => {},
      optIn: () => {},
    };
    const out = await handleInboundSms({
      inbound: { from: FROM, body: "hello?" },
      cfg: CFG,
      config: BASE,
      store: broken,
      contacts: memContacts(),
      fetchImpl: recordingFetch().fn,
      dispatch,
    });
    expect(out).toBe("opted_out");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a confirmation Twilio did not accept is NOT recorded — the next message retries it", async () => {
    const contacts = memContacts();
    const bad = failingFetch();
    await handleInboundSms({
      inbound: { from: FROM, body: "hi" },
      cfg: CFG,
      config: BASE,
      store: memStore(),
      contacts,
      fetchImpl: bad.fn,
      dispatch: vi.fn(async () => {}),
    });
    expect(bad.calls).toEqual([OPT_IN_REPLY]);
    expect(contacts.set.has(FROM)).toBe(false);

    const good = recordingFetch();
    await handleInboundSms({
      inbound: { from: FROM, body: "hi again" },
      cfg: CFG,
      config: BASE,
      store: memStore(),
      contacts,
      fetchImpl: good.fn,
      dispatch: vi.fn(async () => {}),
    });
    expect(good.calls.map((c) => c.body)).toEqual([OPT_IN_REPLY]);
    expect(contacts.set.has(FROM)).toBe(true);
  });

  it("a START whose ack did not go out is NOT recorded as confirmed", async () => {
    const contacts = memContacts();
    await handleInboundSms({
      inbound: { from: FROM, body: "START" },
      cfg: CFG,
      config: BASE,
      store: memStore(),
      contacts,
      fetchImpl: failingFetch().fn,
      dispatch: vi.fn(async () => {}),
    });
    expect(contacts.set.has(FROM)).toBe(false);
  });
});
