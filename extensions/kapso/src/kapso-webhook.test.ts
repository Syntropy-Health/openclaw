import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import {
  createKapsoWebhookHandler,
  createWamidDedup,
  decideKapsoInbound,
  parseKapsoInbounds,
} from "./kapso-webhook.js";

const APP_SECRET = "meta_app_secret";

const CONFIG: ResolvedKapsoConfig = {
  apiKey: "k",
  baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
  phoneNumberId: "PN_1",
  appSecret: APP_SECRET,
  inbound: "pairing",
  allowFrom: [],
};

// Meta's Cloud API delivers `from` as BARE digits (no `+`) — the tests feed bare
// digits and assert the parser normalizes them to canonical +E164 (QG H1).
function messagePayload(from = "15557654321", body = "log an apple", id = "wamid.1"): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "PN_1" },
              messages: [{ from, id, type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  });
}

const statusPayload = JSON.stringify({
  entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }],
});

function sign(rawBody: string, secret = APP_SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

describe("parseKapsoInbounds", () => {
  it("★ normalizes Meta's bare-digit `from` to canonical +E164 (QG H1 — shared opt-out keyspace)", () => {
    // Input is bare digits; the SMS/opt-out store keys on +E164 — parse MUST canonicalize.
    expect(parseKapsoInbounds(JSON.parse(messagePayload("16505551234", "hi")))).toEqual([
      { from: "+16505551234", body: "hi", id: "wamid.1" },
    ]);
  });

  it("is idempotent on an already +E164-prefixed sender", () => {
    expect(parseKapsoInbounds(JSON.parse(messagePayload("+16505551234", "hi")))).toEqual([
      { from: "+16505551234", body: "hi", id: "wamid.1" },
    ]);
  });

  it("carries the wamid (message id) for redelivery dedup", () => {
    expect(
      parseKapsoInbounds(JSON.parse(messagePayload("15557654321", "x", "wamid.ABC")))[0].id,
    ).toBe("wamid.ABC");
  });

  it("defaults an absent text body to empty string", () => {
    const noText = JSON.parse(messagePayload());
    delete noText.entry[0].changes[0].value.messages[0].text;
    expect(parseKapsoInbounds(noText)).toEqual([{ from: "+15557654321", body: "", id: "wamid.1" }]);
  });

  it("★ returns EVERY message in a coalesced (batched) delivery (QG M1)", () => {
    const batched = JSON.parse(messagePayload());
    batched.entry[0].changes[0].value.messages = [
      { from: "15550000001", id: "wamid.a", type: "text", text: { body: "one" } },
      { from: "15550000002", id: "wamid.b", type: "text", text: { body: "two" } },
    ];
    expect(parseKapsoInbounds(batched)).toEqual([
      { from: "+15550000001", body: "one", id: "wamid.a" },
      { from: "+15550000002", body: "two", id: "wamid.b" },
    ]);
  });

  it("returns [] for a non-message event (delivery status)", () => {
    expect(parseKapsoInbounds(JSON.parse(statusPayload))).toEqual([]);
  });
});

describe("createWamidDedup", () => {
  it("claims a fresh id (true) and rejects a re-claim (false)", () => {
    const dedup = createWamidDedup();
    expect(dedup.claim("wamid.1")).toBe(true);
    expect(dedup.claim("wamid.1")).toBe(false);
    expect(dedup.claim("wamid.2")).toBe(true);
  });

  it("release() un-records a claim so it can be re-claimed (failed-processing retry)", () => {
    const dedup = createWamidDedup();
    expect(dedup.claim("wamid.1")).toBe(true);
    expect(dedup.claim("wamid.1")).toBe(false); // still claimed
    dedup.release("wamid.1");
    expect(dedup.claim("wamid.1")).toBe(true); // retryable after release
  });

  it("evicts the oldest id past the bound (memory stays flat)", () => {
    const dedup = createWamidDedup(2);
    expect(dedup.claim("a")).toBe(true); // set: {a}
    expect(dedup.claim("b")).toBe(true); // set: {a,b}
    expect(dedup.claim("c")).toBe(true); // over bound → evict "a" → {b,c}
    expect(dedup.claim("a")).toBe(true); // "a" was evicted → fresh; re-add evicts "b" → {c,a}
    expect(dedup.claim("c")).toBe(false); // "c" still present (claimed)
    expect(dedup.claim("b")).toBe(true); // "b" was evicted → fresh again
  });
});

describe("decideKapsoInbound — x-hub-signature-256 validated before parse/route", () => {
  it("non-POST → 405", () => {
    const raw = messagePayload();
    expect(
      decideKapsoInbound({
        method: "GET",
        signature: sign(raw),
        rawBody: raw,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 405 });
  });

  it("invalid/missing signature → 403 (never surfaces inbound)", () => {
    const raw = messagePayload();
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: "sha256=bad",
        rawBody: raw,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 403 });
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: undefined,
        rawBody: raw,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 403 });
  });

  it("a tampered body invalidates the signature → 403 (integrity)", () => {
    const raw = messagePayload("15557654321", "original");
    const goodSig = sign(raw);
    const tampered = messagePayload("15557654321", "DIFFERENT");
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: goodSig,
        rawBody: tampered,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 403 });
  });

  it("valid signature + message → 200 with the parsed (normalized) inbound", () => {
    const raw = messagePayload("15557654321", "log an apple");
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: sign(raw),
        rawBody: raw,
        appSecret: APP_SECRET,
      }),
    ).toEqual({
      status: 200,
      inbounds: [{ from: "+15557654321", body: "log an apple", id: "wamid.1" }],
    });
  });

  it("valid signature + status event → 200 with empty inbounds (ack, no route)", () => {
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: sign(statusPayload),
        rawBody: statusPayload,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 200, inbounds: [] });
  });

  it("valid signature + non-JSON body → 400", () => {
    const raw = "not json";
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: sign(raw),
        rawBody: raw,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 400 });
  });
});

function fakeReq(opts: {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
}): IncomingMessage {
  const body = opts.body ?? "";
  return {
    method: opts.method ?? "POST",
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
}

function fakeRes() {
  const state = { status: 0 };
  const res = {
    writeHead: (s: number) => {
      state.status = s;
      return res;
    },
    end: () => {},
  };
  return { res: res as unknown as ServerResponse, state };
}

describe("createKapsoWebhookHandler — Node adapter", () => {
  it("503 + no onInbound when the channel is inert", async () => {
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => null, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({}), res);
    expect(state.status).toBe(503);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("200 + onInbound (normalized + wamid) on a valid signed message", async () => {
    const raw = messagePayload("15557654321", "hi");
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw }), res);
    expect(state.status).toBe(200);
    expect(onInbound).toHaveBeenCalledWith({ from: "+15557654321", body: "hi", id: "wamid.1" });
  });

  it("★ delivers onInbound once PER message in a batched delivery (QG M1)", async () => {
    const batched = JSON.parse(messagePayload());
    batched.entry[0].changes[0].value.messages = [
      { from: "15550000001", id: "wamid.a", type: "text", text: { body: "one" } },
      { from: "15550000002", id: "wamid.b", type: "text", text: { body: "two" } },
    ];
    const raw = JSON.stringify(batched);
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw }), res);
    expect(state.status).toBe(200);
    expect(onInbound).toHaveBeenCalledTimes(2);
  });

  it("★ a throwing onInbound cannot hang the request — responds 5xx (H3) and logs", async () => {
    // A compliance-store write failure propagates here; the handler must respond
    // (not hang) AND signal retry via 5xx, never a silent 200.
    const raw = messagePayload("15557654321", "hi");
    const onInbound = vi
      .fn()
      .mockRejectedValue(new Error("opt-out store down (fail-closed throw)"));
    const errors: string[] = [];
    const handler = createKapsoWebhookHandler({
      resolveConfig: () => CONFIG,
      onInbound,
      logger: { error: (m) => errors.push(m) },
    });
    const { res, state } = fakeRes();
    await expect(
      handler(fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw }), res),
    ).resolves.toBeUndefined();
    expect(state.status).toBe(503); // NOT 200 — a failed durable write must be retried
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain("will 5xx for retry");
  });

  it("★ a FAILED message is released — Meta's redelivery re-processes it (STOP-loss regression)", async () => {
    // The core compliance-integrity fix: first attempt throws (DB blip) → released;
    // the redelivery, after "recovery", must run onInbound AGAIN (not be deduped).
    const raw = messagePayload("15557654321", "STOP", "wamid.RETRY");
    let attempt = 0;
    const onInbound = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("pg down (transient)");
      // 2nd attempt succeeds
    });
    const handler = createKapsoWebhookHandler({
      resolveConfig: () => CONFIG,
      onInbound,
      logger: { error: () => {} },
    });
    const req = () => fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw });
    const s1 = fakeRes();
    await handler(req(), s1.res);
    expect(s1.state.status).toBe(503); // first attempt failed → retry signal
    const s2 = fakeRes();
    await handler(req(), s2.res); // Meta redelivery
    expect(s2.state.status).toBe(200); // recovered
    expect(onInbound).toHaveBeenCalledTimes(2); // NOT dropped by dedup
  });

  it("★ a SUCCESSFUL wamid is deduped — Meta redelivery does not re-invoke onInbound (H2)", async () => {
    const raw = messagePayload("15557654321", "hi", "wamid.DUP");
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const req = () => fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw });
    const s1 = fakeRes();
    await handler(req(), s1.res);
    const s2 = fakeRes();
    await handler(req(), s2.res); // Meta redelivery of a succeeded message
    expect(s1.state.status).toBe(200);
    expect(s2.state.status).toBe(200);
    expect(onInbound).toHaveBeenCalledTimes(1);
  });

  it("★ a redelivery racing an IN-FLIGHT message is skipped (claim) — no double-send (H2)", async () => {
    // First delivery's onInbound never resolves (slow agent gen); the redelivery
    // that arrives meanwhile must find the wamid claimed and be skipped.
    const raw = messagePayload("15557654321", "hi", "wamid.SLOW");
    let calls = 0;
    const onInbound = vi.fn(() => {
      calls += 1;
      return new Promise<void>(() => {}); // never resolves
    });
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const req = () => fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw });
    void handler(req(), fakeRes().res); // in-flight, not awaited
    await Promise.resolve(); // let the claim register
    const s2 = fakeRes();
    await handler(req(), s2.res); // redelivery during processing
    expect(s2.state.status).toBe(200); // acked; work skipped
    expect(calls).toBe(1); // second delivery did NOT invoke onInbound
  });

  it("processes a message with NO wamid (undefined id bypasses dedup, still routed)", async () => {
    const noId = JSON.parse(messagePayload());
    delete noId.entry[0].changes[0].value.messages[0].id;
    const raw = JSON.stringify(noId);
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw }), res);
    expect(state.status).toBe(200);
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound.mock.calls[0][0].id).toBeUndefined();
  });

  it("200 + NO onInbound on a valid signed status event (ack only)", async () => {
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(
      fakeReq({ headers: { "x-hub-signature-256": sign(statusPayload) }, body: statusPayload }),
      res,
    );
    expect(state.status).toBe(200);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("403 + NO onInbound on a forged signature", async () => {
    const raw = messagePayload();
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ headers: { "x-hub-signature-256": "sha256=forged" }, body: raw }), res);
    expect(state.status).toBe(403);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("413 on an over-cap streamed body (no content-length header)", async () => {
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ body: "x".repeat(200 * 1024) }), res);
    expect(state.status).toBe(413);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("★ 413 early-reject on a declared content-length over the cap (body never read)", async () => {
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    let bodyRead = false;
    const req = {
      method: "POST",
      headers: { "content-length": String(200 * 1024) },
      async *[Symbol.asyncIterator]() {
        bodyRead = true;
        yield Buffer.from("x");
      },
    } as unknown as IncomingMessage;
    await handler(req, res);
    expect(state.status).toBe(413);
    expect(bodyRead).toBe(false);
    expect(onInbound).not.toHaveBeenCalled();
  });
});
