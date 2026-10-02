/**
 * End-to-end wiring: a SIGNED Twilio webhook through the route the plugin actually
 * registers. Proves pluginConfig.keywordReplies reaches handleInboundSms (a
 * boot-log assertion alone could not — dropping the argument would leave it green).
 */
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import twilioSmsPlugin from "./index.js";

const ENV = {
  TWILIO_SMS_ACCOUNT_SID: "AC_wire",
  TWILIO_SMS_API_KEY_SID: "SK_wire",
  TWILIO_SMS_API_KEY_SECRET: "secret_wire",
  TWILIO_SMS_AUTH_TOKEN: "hmac_wire",
  TWILIO_SMS_NUMBER: "+15550008434",
};
const HOST = "gw.example";
const URL = `https://${HOST}/twilio/sms`;

function sign(params: URLSearchParams): string {
  const sorted = Array.from(params.entries()).toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  let data = URL;
  for (const [k, v] of sorted) data += k + v;
  return crypto.createHmac("sha1", ENV.TWILIO_SMS_AUTH_TOKEN).update(data).digest("base64");
}

async function postKeyword(keywordReplies: unknown, params: URLSearchParams) {
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  delete process.env.DATABASE_URL;
  const twilioCalls: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    twilioCalls.push(
      `${String(url)} ${String((init?.body as URLSearchParams | undefined)?.get("Body") ?? "")}`,
    );
    return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
  });
  try {
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
    const api = {
      id: "twilio",
      config: { channels: {} },
      pluginConfig: { smsEnabled: true, keywordReplies },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerChannel: vi.fn(),
      registerHttpRoute: vi.fn((r: { handler: typeof handler }) => {
        handler = r.handler;
      }),
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;
    await twilioSmsPlugin.register(api);
    const body = params.toString();
    const req = {
      method: "POST",
      url: "/twilio/sms",
      headers: { host: HOST, "x-forwarded-proto": "https", "x-twilio-signature": sign(params) },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;
    const state = { status: 0 };
    const res = {
      writeHead: (s: number) => {
        state.status = s;
        return res;
      },
      end: () => {},
    } as unknown as ServerResponse;
    await handler!(req, res);
    return { status: state.status, twilioCalls };
  } finally {
    fetchSpy.mockRestore();
    process.env = saved;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("keywordReplies reaches the live webhook path", () => {
  const STOP = () =>
    new URLSearchParams({
      From: "+15557654321",
      To: ENV.TWILIO_SMS_NUMBER,
      Body: "STOP",
      OptOutType: "STOP",
    });

  it('"twilio": a Twilio-handled STOP produces ZERO sends from openclaw', async () => {
    const r = await postKeyword("twilio", STOP());
    expect(r.status).toBe(200);
    expect(r.twilioCalls).toEqual([]);
  });

  it("default (openclaw): the same STOP gets our registered reply", async () => {
    const r = await postKeyword(undefined, STOP());
    expect(r.status).toBe(200);
    expect(r.twilioCalls).toHaveLength(1);
    expect(r.twilioCalls[0]).toContain("you're unsubscribed");
  });
});
