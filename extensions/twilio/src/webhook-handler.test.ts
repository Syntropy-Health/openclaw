import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { createSmsWebhookHandler } from "./webhook.js";

const CONFIG: ResolvedTwilioSmsConfig = {
  accountSid: "AC_x",
  apiKeySid: "SK_x",
  apiKeySecret: "secret_x",
  authToken: "webhook_hmac_key",
  smsNumber: "+15550001234",
  inbound: "pairing",
  allowFrom: [],
};
const URL = "https://hooks.example.com/twilio/sms";

function twilioSign(url: string, params: URLSearchParams): string {
  const sorted = Array.from(params.entries()).toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  let data = url;
  for (const [k, v] of sorted) data += k + v;
  return crypto.createHmac("sha1", CONFIG.authToken).update(data).digest("base64");
}

function fakeReq(opts: {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
}): IncomingMessage {
  const body = opts.body ?? "";
  return {
    method: opts.method ?? "POST",
    headers: opts.headers ?? {},
    url: "/twilio/sms",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
}

function fakeRes() {
  const state = { status: 0, body: "" };
  const res = {
    writeHead: (s: number) => {
      state.status = s;
      return res;
    },
    end: (b?: string) => {
      if (b) state.body = b;
    },
  };
  return { res: res as unknown as ServerResponse, state };
}

describe("createSmsWebhookHandler — Node adapter", () => {
  it("returns 503 and does NOT call onInbound when the channel is inert (resolveConfig null)", async () => {
    const onInbound = vi.fn();
    const handler = createSmsWebhookHandler({ resolveConfig: () => null, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({}), res);
    expect(state.status).toBe(503);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("returns 200 + empty TwiML and calls onInbound once on a valid signature", async () => {
    const params = new URLSearchParams({ From: "+15557654321", Body: "hi there" });
    const onInbound = vi.fn();
    const handler = createSmsWebhookHandler({
      resolveConfig: () => CONFIG,
      onInbound,
      resolveUrl: () => URL,
    });
    const { res, state } = fakeRes();
    await handler(
      fakeReq({
        headers: { "x-twilio-signature": twilioSign(URL, params) },
        body: params.toString(),
      }),
      res,
    );
    expect(state.status).toBe(200);
    expect(state.body).toContain("<Response>");
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound).toHaveBeenCalledWith({ from: "+15557654321", body: "hi there" });
  });

  it("returns 403 and does NOT call onInbound on a forged signature (no bypass through the adapter)", async () => {
    const params = new URLSearchParams({ From: "+15557654321", Body: "hi" });
    const onInbound = vi.fn();
    const handler = createSmsWebhookHandler({
      resolveConfig: () => CONFIG,
      onInbound,
      resolveUrl: () => URL,
    });
    const { res, state } = fakeRes();
    await handler(
      fakeReq({ headers: { "x-twilio-signature": "forged" }, body: params.toString() }),
      res,
    );
    expect(state.status).toBe(403);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("returns 413 (no buffering) when Content-Length exceeds the cap", async () => {
    const onInbound = vi.fn();
    const handler = createSmsWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ headers: { "content-length": String(200 * 1024) } }), res);
    expect(state.status).toBe(413);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it("returns 413 when the STREAMED body exceeds the cap even without Content-Length", async () => {
    const onInbound = vi.fn();
    const handler = createSmsWebhookHandler({ resolveConfig: () => CONFIG, onInbound });
    const { res, state } = fakeRes();
    await handler(fakeReq({ body: "x".repeat(70 * 1024) }), res);
    expect(state.status).toBe(413);
    expect(onInbound).not.toHaveBeenCalled();
  });
});
