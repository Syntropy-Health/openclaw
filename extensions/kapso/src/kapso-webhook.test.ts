import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import {
  createKapsoWebhookHandler,
  decideKapsoInbound,
  parseKapsoInbound,
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

function messagePayload(from = "15557654321", body = "log an apple"): string {
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
              messages: [{ from, id: "wamid.1", type: "text", text: { body } }],
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

describe("parseKapsoInbound", () => {
  it("extracts { from, body } from a Cloud API message payload", () => {
    expect(parseKapsoInbound(JSON.parse(messagePayload("15557654321", "hi")))).toEqual({
      from: "15557654321",
      body: "hi",
    });
  });
  it("defaults an absent text body to empty string", () => {
    const noText = JSON.parse(messagePayload());
    delete noText.entry[0].changes[0].value.messages[0].text;
    expect(parseKapsoInbound(noText)).toEqual({ from: "15557654321", body: "" });
  });
  it("returns null for a non-message event (delivery status)", () => {
    expect(parseKapsoInbound(JSON.parse(statusPayload))).toBeNull();
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

  it("valid signature + message → 200 with the parsed inbound", () => {
    const raw = messagePayload("15557654321", "log an apple");
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: sign(raw),
        rawBody: raw,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 200, inbound: { from: "15557654321", body: "log an apple" } });
  });

  it("valid signature + status event → 200 with null inbound (ack, no route)", () => {
    expect(
      decideKapsoInbound({
        method: "POST",
        signature: sign(statusPayload),
        rawBody: statusPayload,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ status: 200, inbound: null });
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

  it("200 + onInbound on a valid signed message", async () => {
    const raw = messagePayload("15557654321", "hi");
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ headers: { "x-hub-signature-256": sign(raw) }, body: raw }), res);
    expect(state.status).toBe(200);
    expect(onInbound).toHaveBeenCalledWith({ from: "15557654321", body: "hi" });
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

  it("413 on an over-cap streamed body", async () => {
    const onInbound = vi.fn();
    const handler = createKapsoWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ body: "x".repeat(200 * 1024) }), res);
    expect(state.status).toBe(413);
    expect(onInbound).not.toHaveBeenCalled();
  });
});
