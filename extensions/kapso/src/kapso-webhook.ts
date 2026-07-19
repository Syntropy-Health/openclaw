/**
 * Kapso inbound WhatsApp webhook (B-Kapso-1, slice 2) — the signature gate + parse.
 *
 * Order is load-bearing (mirrors the SMS webhook): non-POST → 405; then
 * `X-Hub-Signature-256` validated over the RAW body BEFORE any parse/route
 * (mismatch → 403, never surfaces an inbound); then parse the Cloud API payload.
 * Valid non-message events (delivery statuses) are 200-acked without routing so
 * Meta stops retrying. The compliance-first + agent dispatch composition is wired
 * at slice 3 via `onInbound` (reusing the shared rails).
 *
 * Two reliability invariants the gate enforces (QG H2/H3) — and the compliance-
 * integrity correction from the follow-up review:
 *  - Double-send under Meta's at-least-once redelivery is defended by a `wamid`
 *    CLAIM: the first delivery of an id claims it; a redelivery arriving while the
 *    first is still processing (the exact ack-window case) finds it claimed and is
 *    skipped — so a slow-but-successful dispatch can't be re-run. This is the
 *    "dedup" arm of the gate's "ack-first AND/OR dedup" guidance, and it removes
 *    the double-send hazard without acking before the durable work is done.
 *  - `onInbound` is wrapped so a throw can never hang the socket (H3). But a
 *    COMPLIANCE-store write that throws (the fail-closed opt-out store throws BY
 *    DESIGN on a DB blip) must NOT be acked-and-forgotten: the claim is RELEASED
 *    and the handler responds 5xx, so Meta redelivers and the opt-out is retried
 *    on recovery. Acking 200 on a failed STOP write would silently drop the
 *    opt-out (a TCPA violation) — so the ack reflects success. Agent-dispatch
 *    failures, by contrast, are logged-and-swallowed inside the handler (not
 *    retry-worthy) and still 200.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeE164 } from "openclaw/plugin-sdk";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import { verifyXHubSignature256 } from "./kapso-webhook-security.js";

/**
 * A routable inbound message. `from` is canonical `+E164` (normalized at the
 * parse boundary — see below); `id` is the Cloud API `wamid` used for
 * redelivery idempotency.
 */
export type KapsoInbound = { from: string; body: string; id?: string };

/** Minimal logger seam (matches the plugin api.logger shape; all methods optional). */
export type KapsoLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

/**
 * Extract every inbound message from a Cloud API webhook payload, iterating ALL
 * `entry[].changes[].value.messages[]` (Meta coalesces multiple messages into one
 * delivery — QG M1: reading only `[0]` silently dropped the rest). Non-message
 * events (delivery statuses) yield an empty array.
 *
 * Each sender is normalized to canonical `+E164` via the shared `normalizeE164`
 * (QG H1). Meta's Cloud API delivers `from` as bare digits (`16505551234`), but
 * the shared opt-out store + the Twilio SMS/WABA rails key on `+E164`. Without
 * this, a STOP over SMS (stored `+1650…`) would not suppress a Kapso WhatsApp
 * send (checked as `1650…`) — the "one opt-out keyspace across SMS + WhatsApp"
 * guarantee, and `inbound: "allowlist"`, both depend on canonical keys.
 * `normalizeE164` never throws and is idempotent (`+`-prefixed input passes
 * through unchanged).
 */
export function parseKapsoInbounds(payload: unknown): KapsoInbound[] {
  const entries =
    (payload as { entry?: Array<{ changes?: Array<{ value?: unknown }> }> })?.entry ?? [];
  const out: KapsoInbound[] = [];
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value as
        | { messages?: Array<{ from?: string; id?: string; text?: { body?: string } }> }
        | undefined;
      for (const msg of value?.messages ?? []) {
        if (!msg?.from) continue;
        const from = normalizeE164(msg.from);
        // A non-digit `from` collapses to the bare "+" under normalizeE164; drop it
        // rather than route distinct malformed senders under one shared key/session.
        if (from === "+") continue;
        out.push({ from, body: msg.text?.body ?? "", id: msg.id });
      }
    }
  }
  return out;
}

/** The gate's decision. A 200 with a non-empty `inbounds` is the only routable case. */
export type KapsoInboundDecision =
  | { status: 405 }
  | { status: 403 }
  | { status: 400 }
  | { status: 200; inbounds: KapsoInbound[] };

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
  return { status: 200, inbounds: parseKapsoInbounds(payload) };
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

/**
 * Bounded `wamid` idempotency claim (QG H2 + compliance-integrity review). Meta
 * redelivers on any missed/late ack; a message id must be processed at most once.
 * `claim` records the id and returns true on first sight (proceed), false if it is
 * already claimed/processed (skip). `release` un-records it so a message whose
 * processing FAILED can be retried on Meta's next redelivery — marking-seen must
 * never outlive an unsuccessful durable write. Bounded FIFO eviction keeps memory
 * flat; the window only needs to outlast Meta's retry burst.
 */
export function createWamidDedup(max = 4096): {
  claim: (id: string) => boolean;
  release: (id: string) => void;
} {
  const seen = new Set<string>();
  return {
    claim(id: string): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > max) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    release(id: string): void {
      seen.delete(id);
    },
  };
}

export type KapsoWebhookDeps = {
  /** Resolve the current config per request (null → inert channel → 503). */
  resolveConfig: () => ResolvedKapsoConfig | null;
  /** Called ONLY for an authenticated, routable inbound message (200 + non-empty inbounds). */
  onInbound: (inbound: KapsoInbound) => void | Promise<void>;
  /** Optional logger for post-ack processing failures (QG H3/M2). */
  logger?: KapsoLogger;
};

/** Node adapter: cap → validate → 200-ack → (per message) dedup → onInbound. */
export function createKapsoWebhookHandler(deps: KapsoWebhookDeps) {
  const dedup = createWamidDedup();
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

    if (decision.status !== 200) {
      res.writeHead(decision.status);
      res.end();
      return;
    }

    // Process every message; the ACK reflects success. A message whose durable
    // (compliance) work throws is RELEASED and forces a 5xx so Meta redelivers and
    // retries it — never acked-and-lost. The claim makes a redelivery that races an
    // in-flight message a no-op, so this cannot double-send a slow-but-successful one.
    let retryable = false;
    for (const inbound of decision.inbounds) {
      // Skip a wamid already claimed/processed (Meta redelivery / at-least-once).
      if (inbound.id && !dedup.claim(inbound.id)) continue;
      try {
        await deps.onInbound(inbound);
      } catch (err) {
        // Only compliance-store WRITE failures propagate here (the handler swallows
        // agent-dispatch failures itself). A failed opt-out write must be retried,
        // so release the claim and signal Meta to redeliver via the 5xx below.
        if (inbound.id) dedup.release(inbound.id);
        retryable = true;
        deps.logger?.error?.(
          `kapso: inbound processing failed — will 5xx for retry: ${String(err)}`,
        );
      }
    }
    // H3: always WRITE a response (never hang the socket). 5xx only when a durable
    // write failed → Meta redelivers the released message; else 200 so Meta stops.
    res.writeHead(retryable ? 503 : 200);
    res.end();
  };
}
