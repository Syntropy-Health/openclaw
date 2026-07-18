/**
 * Kapso inbound WhatsApp webhook (B-Kapso-1, slice 2) — the signature gate + parse.
 *
 * Order is load-bearing (mirrors the SMS webhook): non-POST → 405; then
 * `X-Hub-Signature-256` validated over the RAW body BEFORE any parse/route
 * (mismatch → 403, never surfaces an inbound); then parse the Cloud API payload.
 * Valid non-message events (delivery statuses) are 200-acked without routing so
 * Meta stops retrying. The compliance-first + agent dispatch composition is wired
 * at slice 3 via `onInbound` (reusing the shared rails).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import { verifyXHubSignature256 } from "./kapso-webhook-security.js";

export type KapsoInbound = { from: string; body: string };

/**
 * Extract `{ from, body }` from a Cloud API inbound webhook payload
 * (`entry[].changes[].value.messages[]`). Returns null for non-message events
 * (e.g. delivery statuses) or a message with no sender.
 */
export function parseKapsoInbound(payload: unknown): KapsoInbound | null {
  const value = (payload as { entry?: Array<{ changes?: Array<{ value?: unknown }> }> })?.entry?.[0]
    ?.changes?.[0]?.value as
    | { messages?: Array<{ from?: string; text?: { body?: string } }> }
    | undefined;
  const msg = value?.messages?.[0];
  if (!msg?.from) return null;
  return { from: msg.from, body: msg.text?.body ?? "" };
}

/** The gate's decision. A 200 with a non-null `inbound` is the only routable case. */
export type KapsoInboundDecision =
  | { status: 405 }
  | { status: 403 }
  | { status: 400 }
  | { status: 200; inbound: KapsoInbound | null };

/** Pure inbound decision — signature validated BEFORE parse/route. */
export function decideKapsoInbound(input: {
  method: string | undefined;
  signature: string | undefined;
  rawBody: string;
  appSecret: string;
}): KapsoInboundDecision {
  if ((input.method ?? "").toUpperCase() !== "POST") return { status: 405 };
  if (!verifyXHubSignature256(input.rawBody, input.signature, input.appSecret)) {
    return { status: 403 };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400 };
  }
  return { status: 200, inbound: parseKapsoInbound(payload) };
}

/**
 * Max inbound body we buffer. Unauthenticated until the signature is validated
 * (which needs the raw body), so a cap is required (CWE-770). Cloud API webhooks
 * are small; 128 KB is generous.
 */
export const MAX_INBOUND_BODY_BYTES = 128 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the inbound cap");
    this.name = "BodyTooLargeError";
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_INBOUND_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export type KapsoWebhookDeps = {
  /** Resolve the current config per request (null → inert channel → 503). */
  resolveConfig: () => ResolvedKapsoConfig | null;
  /** Called ONLY for an authenticated, routable inbound message (200 + non-null inbound). */
  onInbound: (inbound: KapsoInbound) => void | Promise<void>;
};

/** Node adapter: cap → validate → (routable) onInbound → 200-ack. */
export function createKapsoWebhookHandler(deps: KapsoWebhookDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const config = deps.resolveConfig();
    if (!config) {
      res.writeHead(503);
      res.end();
      return;
    }

    const declaredLength = Number(firstHeader(req.headers["content-length"]));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INBOUND_BODY_BYTES) {
      res.writeHead(413);
      res.end();
      return;
    }
    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413);
        res.end();
        return;
      }
      throw err;
    }

    const decision = decideKapsoInbound({
      method: req.method,
      signature: firstHeader(req.headers["x-hub-signature-256"]),
      rawBody,
      appSecret: config.appSecret,
    });

    if (decision.status === 200) {
      if (decision.inbound) await deps.onInbound(decision.inbound);
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(decision.status);
    res.end();
  };
}
