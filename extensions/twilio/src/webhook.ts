/**
 * Twilio SMS inbound webhook (B-Twilio-1, slice 3) — the signature gate.
 *
 * Per AD-onboarding-channels §4.3 (non-negotiable): every inbound Twilio POST
 * MUST have its `X-Twilio-Signature` validated (HMAC-SHA1 over URL + sorted
 * params, subaccount Auth Token as the key) BEFORE anything it carries is
 * parsed or routed to the agent. A signature mismatch is rejected (403) and
 * NEVER reaches the router.
 *
 * The HMAC validator is REUSED from the voice-call extension
 * (`validateTwilioSignature`) — a pure, timing-safe function — rather than
 * re-implemented, so the security-critical crypto has a single source of truth
 * (precedent: syntropy-mcp reuses syntropy/src primitives). The subaccount Auth
 * Token is the ONLY place an Auth Token is used (never for REST send, §4.2).
 *
 * The security decision (`decideInboundSms`) is a pure function so the gate is
 * exhaustively testable without Node http; `createSmsWebhookHandler` is the
 * thin IncomingMessage/ServerResponse adapter around it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { validateTwilioSignature } from "../../voice-call/src/webhook-security.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";

export type InboundSms = { from: string; body: string };

/**
 * Extract `{ from, body }` from Twilio inbound SMS form params. `From` is the
 * required routing key (E.164 peer); `Body` defaults to empty (a blank SMS is
 * still a routable event). Returns null when unroutable (no `From`).
 */
export function parseInboundSms(params: URLSearchParams): InboundSms | null {
  const from = params.get("From");
  if (!from) return null;
  return { from, body: params.get("Body") ?? "" };
}

/** The gate's decision. 200 is the only status that carries a routable inbound. */
export type InboundDecision =
  | { status: 405 }
  | { status: 403 }
  | { status: 400 }
  | { status: 200; inbound: InboundSms };

/**
 * Pure inbound decision — the security gate. Order is load-bearing:
 *  1. Non-POST → 405 (no validation, no routing).
 *  2. Signature invalid/absent → 403 (REJECTED before parse/route).
 *  3. Authenticated but no `From` → 400 (can't route).
 *  4. Authenticated + routable → 200 with the parsed inbound.
 * Signature validation happens BEFORE `parseInboundSms`, so a forged request
 * never surfaces an inbound to the caller.
 */
export function decideInboundSms(input: {
  method: string | undefined;
  signature: string | undefined;
  url: string;
  bodyParams: URLSearchParams;
  authToken: string;
}): InboundDecision {
  if ((input.method ?? "").toUpperCase() !== "POST") return { status: 405 };
  if (!validateTwilioSignature(input.authToken, input.signature, input.url, input.bodyParams)) {
    return { status: 403 };
  }
  const inbound = parseInboundSms(input.bodyParams);
  if (!inbound) return { status: 400 };
  return { status: 200, inbound };
}

/** Read a request body stream to a UTF-8 string (bounded by the caller's server). */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type SmsWebhookDeps = {
  config: ResolvedTwilioSmsConfig;
  /** Called ONLY for authenticated, routable inbound (status 200). */
  onInbound: (inbound: InboundSms) => void | Promise<void>;
  /**
   * Reconstruct the public URL Twilio signed. Twilio signs the exact URL it
   * POSTed to (incl. scheme/host/path), which is not always recoverable from
   * `req` behind proxies — the plugin provides it. Defaults to a best-effort
   * host-header reconstruction.
   */
  resolveUrl?: (req: IncomingMessage) => string;
};

/** Node adapter: validate → (on 200) route → respond. Thin wrapper over the pure core. */
export function createSmsWebhookHandler(deps: SmsWebhookDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req);
    const bodyParams = new URLSearchParams(raw);
    const signature = firstHeader(req.headers["x-twilio-signature"]);
    const url = deps.resolveUrl?.(req) ?? defaultUrl(req);

    const decision = decideInboundSms({
      method: req.method,
      signature,
      url,
      bodyParams,
      authToken: deps.config.authToken,
    });

    if (decision.status === 200) {
      await deps.onInbound(decision.inbound);
      // Empty TwiML — we reply out-of-band via the send path, not the webhook response.
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<Response></Response>");
      return;
    }
    res.writeHead(decision.status);
    res.end();
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function defaultUrl(req: IncomingMessage): string {
  const host = firstHeader(req.headers.host) ?? "localhost";
  const proto = firstHeader(req.headers["x-forwarded-proto"]) ?? "https";
  return `${proto}://${host}${req.url ?? ""}`;
}
