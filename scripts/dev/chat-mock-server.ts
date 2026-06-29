/**
 * chat-mock-server — a standalone, channels-FREE, contract-faithful MOCK of the
 * openclaw chat endpoint, for the shrinemobile ↔ openclaw integration co-debug.
 *
 * WHY THIS EXISTS (and how it differs from chat-auth-qa-preview.ts):
 *   chat-auth-qa-preview.ts boots the REAL gateway (`startGatewayServer`) — which
 *   wires the WhatsApp client + channels + the live agent. That CONFLICTS with the
 *   live launchd bot (status 440) and depends on a real agent producing replies
 *   locally. shrinemobile needs to debug their SSE parsing + auth + error-map + UX
 *   rendering DETERMINISTICALLY, with NO LLM and NO live-bot dependency.
 *
 *   So this server:
 *     - has NO channels / NO WhatsApp / NO startGatewayServer (safe to run
 *       ALONGSIDE the live bot),
 *     - reuses the REAL Clerk-JWT verifier (`verifyClerkJwt` from
 *       src/gateway/clerk-jwt.ts) against a LOCAL JWKS — so the AUTH PATH IS REAL
 *       (valid → 200; missing/malformed/expired/bad-aud/bad-iss → 401 fail-closed),
 *     - streams a DETERMINISTIC mock reply whose wire shape is byte-faithful to the
 *       real handler (src/gateway/openresponses-http.ts) — same SSE event `type`
 *       strings, same per-event JSON field names, same §2.3 non-stream envelope.
 *
 * The mock reply ECHOES the request (input + resolved scope + session/device
 * headers) so shrinemobile can SEE scope threading round-trip.
 *
 * Usage:
 *   node --import tsx scripts/dev/chat-mock-server.ts [--port 18799]
 *        [--stream-delay-ms 60] [--budget 5] [--sub user_qa_alice]
 *        [--legacy-token <tok>]
 *
 * Ctrl-C to stop.
 */
import { generateKeyPairSync, type KeyObject, sign as cryptoSign, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { verifyClerkJwt } from "../../src/gateway/clerk-jwt.js";

// --- tiny arg parser --------------------------------------------------------

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(getArg("--port") ?? 18799);
const STREAM_DELAY_MS = Number(getArg("--stream-delay-ms") ?? 60);
const BUDGET_ARG = getArg("--budget");
const CLI_BUDGET = BUDGET_ARG === undefined ? undefined : Number(BUDGET_ARG); // turns per sub
const SUB = getArg("--sub") ?? "user_qa_alice";
const CLI_LEGACY_TOKEN = getArg("--legacy-token"); // optional legacy unscoped-path token

// --- Clerk JWT minting (local dev mode; mirrors chat-auth-qa-preview.ts) -----

const KID = "chat-mock-kid";
const ISSUER = "https://chat-mock.clerk.local";
const AUDIENCE = "openclaw-chat-mock";
const RETRY_AFTER_SECONDS = 60;

type JwkWithMeta = JsonWebKey & { kid?: string; alg?: string; use?: string };

function makeKeypair(kid: string): { privateKey: KeyObject; jwk: JwkWithMeta } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JwkWithMeta;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function mintToken(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = b64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64url(payload);
  const signingInput = `${header}.${body}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}
function clerkBearer(sub: string, privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  return mintToken({ sub, iss: ISSUER, aud: AUDIENCE, exp: now + 3600, nbf: now - 60 }, privateKey);
}

// --- wire helpers (byte-faithful to src/gateway/http-common.ts) --------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function setSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

// Mirrors openresponses-http.ts `writeSseEvent`: a named SSE frame whose `data:`
// payload is the ENTIRE event object (NOT just the delta). This is the exact
// on-wire shape shrinemobile parses, so we reproduce it verbatim.
function writeSseEvent(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`event: ${event.type as string}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeDone(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
}

// --- §2.3 / §2.2 envelope builders (mirror openresponses-http.ts) ------------

type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };

function mockUsage(text: string): Usage {
  // Deterministic, plausible token accounting (word-count based) so the client
  // can read a non-zero `usage` block off `response.completed` / §2.3.
  const output = Math.max(1, text.split(/\s+/).filter(Boolean).length);
  const input = 8;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function createResponseResource(params: {
  id: string;
  model: string;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  output: unknown[];
  usage?: Usage;
  createdAt: number;
  error?: { code: string; message: string } | null;
}): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    id: params.id,
    object: "response",
    created_at: params.createdAt,
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  // The real handler only sets `error` when present (undefined otherwise); §2.3
  // documents `error: null` for the non-stream body, so callers pass null there.
  if (params.error !== undefined) {
    resource.error = params.error;
  }
  return resource;
}

function createAssistantOutputItem(params: {
  id: string;
  text: string;
  status?: "in_progress" | "completed";
}): Record<string, unknown> {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    ...(params.status ? { status: params.status } : {}),
  };
}

// --- request parsing --------------------------------------------------------

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = raw.slice(7).trim();
  return token || undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Extract a plain-text input string from §2.1 `input` (string OR item[]). */
function extractInputText(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input.length > 0 ? input : undefined;
  }
  if (Array.isArray(input)) {
    const parts: string[] = [];
    for (const item of input) {
      const it = item as { type?: string; content?: unknown };
      if (it.type !== "message") {
        continue;
      }
      if (typeof it.content === "string") {
        if (it.content) {
          parts.push(it.content);
        }
        continue;
      }
      if (Array.isArray(it.content)) {
        for (const part of it.content) {
          const p = part as { type?: string; text?: string };
          if ((p.type === "input_text" || p.type === "output_text") && typeof p.text === "string") {
            if (p.text) {
              parts.push(p.text);
            }
          }
        }
      }
    }
    const joined = parts.join("\n");
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

/** Chunk text into ~4-8 SSE deltas (contract §2.2). */
function chunkText(text: string, targetChunks = 6): string[] {
  if (text.length === 0) {
    return [""];
  }
  const n = Math.min(targetChunks, Math.max(1, text.length));
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- auth resolution --------------------------------------------------------

/** scope = verified Clerk sub, or undefined for the legacy (unscoped) token. */
type AuthOutcome = { ok: true; scope: string | undefined } | { ok: false };

type ClerkConfig = { jwksUrl: string; issuer: string; audience: string };

async function resolveAuth(
  req: IncomingMessage,
  clerk: ClerkConfig,
  legacyToken: string | undefined,
): Promise<AuthOutcome> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false };
  }
  // Legacy shared-token path → 200 but UNSCOPED (no sub). Mirrors the gateway's
  // "auth fails closed, meter fails open on missing user_scope" posture.
  if (legacyToken && token === legacyToken) {
    return { ok: true, scope: undefined };
  }
  const verified = await verifyClerkJwt(token, clerk);
  if (!verified) {
    return { ok: false };
  }
  return { ok: true, scope: verified.sub };
}

// --- the shared request handler ---------------------------------------------

type HandlerDeps = {
  clerk: ClerkConfig;
  legacyToken: string | undefined;
  budget: number | undefined;
  streamDelayMs: number;
  turns: Map<string, number>;
};

function budgetExhausted(deps: HandlerDeps, scope: string | undefined): boolean {
  if (deps.budget === undefined || scope === undefined) {
    return false;
  } // unlimited / unscoped
  return (deps.turns.get(scope) ?? 0) >= deps.budget;
}
function recordTurn(deps: HandlerDeps, scope: string | undefined): void {
  if (deps.budget === undefined || scope === undefined) {
    return;
  }
  deps.turns.set(scope, (deps.turns.get(scope) ?? 0) + 1);
}

async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  // --- AUTH (REAL, fail-closed) ---
  const auth = await resolveAuth(req, deps.clerk, deps.legacyToken);
  if (!auth.ok) {
    sendJson(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
    return;
  }
  const scope = auth.scope; // verified Clerk sub, or undefined for legacy

  // --- body / §2.1 validation ---
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
    return;
  }

  const inputText = extractInputText(body.input);
  if (inputText === undefined) {
    sendJson(res, 400, {
      error: { message: "Missing user message in `input`.", type: "invalid_request_error" },
    });
    return;
  }

  // --- optional τ budget → 429 + Retry-After (BEFORE producing a reply) ---
  if (budgetExhausted(deps, scope)) {
    res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    sendJson(res, 429, {
      error: { message: "Rate limit exceeded. Please retry later.", type: "rate_limited" },
    });
    return;
  }

  const model = typeof body.model === "string" && body.model ? body.model : "openclaw";
  const stream = Boolean(body.stream);
  const sessionKey = getHeader(req, "x-openclaw-session-key");
  const deviceId = getHeader(req, "x-openclaw-device-id");

  // --- DETERMINISTIC mock reply that echoes the request + scope threading ---
  const scopeLabel = scope ?? "unscoped";
  const mockText =
    `[mock] you said: ${inputText} ` +
    `(scope=${scopeLabel}, session=${sessionKey ?? "none"}, device=${deviceId ?? "none"})`;

  const responseId = `resp_${randomUUID()}`;
  const outputItemId = `msg_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const usage = mockUsage(mockText);

  // Charge the turn now that we are committed to producing a reply.
  recordTurn(deps, scope);

  if (!stream) {
    // §2.3 non-streaming envelope.
    const response = createResponseResource({
      id: responseId,
      model,
      status: "completed",
      createdAt,
      output: [
        createAssistantOutputItem({ id: outputItemId, text: mockText, status: "completed" }),
      ],
      usage,
      error: null,
    });
    sendJson(res, 200, response);
    return;
  }

  // --- §2.2 streaming: the EXACT named-event sequence the real handler emits ---
  setSseHeaders(res);

  const initialResponse = createResponseResource({
    id: responseId,
    model,
    status: "in_progress",
    createdAt,
    output: [],
  });
  writeSseEvent(res, { type: "response.created", response: initialResponse });
  writeSseEvent(res, { type: "response.in_progress", response: initialResponse });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: createAssistantOutputItem({ id: outputItemId, text: "", status: "in_progress" }),
  });
  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  // Incremental text deltas (each `data:` is the full delta event object).
  for (const delta of chunkText(mockText)) {
    if (deps.streamDelayMs > 0) {
      await sleep(deps.streamDelayMs);
    }
    if (res.writableEnded) {
      return;
    } // client disconnected
    writeSseEvent(res, {
      type: "response.output_text.delta",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  writeSseEvent(res, {
    type: "response.output_text.done",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    text: mockText,
  });
  writeSseEvent(res, {
    type: "response.content_part.done",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: mockText },
  });

  const completedItem = createAssistantOutputItem({
    id: outputItemId,
    text: mockText,
    status: "completed",
  });
  writeSseEvent(res, {
    type: "response.output_item.done",
    output_index: 0,
    item: completedItem,
  });

  const finalResponse = createResponseResource({
    id: responseId,
    model,
    status: "completed",
    createdAt,
    output: [completedItem],
    usage,
  });
  writeSseEvent(res, { type: "response.completed", response: finalResponse });
  writeDone(res);
  res.end();
}

// --- server factory (exported for tests) ------------------------------------

/**
 * Build + start the mock chat server and its local JWKS server on the given port
 * (0 = ephemeral). NO channels, NO startGatewayServer — safe alongside the live bot.
 */
export async function startChatMockServer(opts?: {
  port?: number;
  host?: string;
  budget?: number;
  streamDelayMs?: number;
  legacyToken?: string;
}): Promise<{
  port: number;
  baseUrl: string;
  clerk: ClerkConfig;
  issuer: string;
  audience: string;
  mintBearer: (sub: string) => string;
  close: () => Promise<void>;
}> {
  const host = opts?.host ?? "127.0.0.1";
  const budget = opts?.budget ?? CLI_BUDGET;
  const streamDelayMs = opts?.streamDelayMs ?? STREAM_DELAY_MS;
  const legacyToken = opts?.legacyToken ?? CLI_LEGACY_TOKEN;

  // Local JWKS source: mint a throwaway RSA keypair and serve its public JWK.
  const kp = makeKeypair(KID);
  const jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [kp.jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, host, resolve));
  const jwksAddr = jwksServer.address() as AddressInfo;
  const clerk: ClerkConfig = {
    jwksUrl: `http://${host}:${jwksAddr.port}/.well-known/jwks.json`,
    issuer: ISSUER,
    audience: AUDIENCE,
  };

  const deps: HandlerDeps = {
    clerk,
    legacyToken,
    budget,
    streamDelayMs,
    turns: new Map<string, number>(),
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = (req.url ?? "").split("?")[0];
        // Both routes share the same auth + mock behavior so the alias path is
        // testable. (chat/completions is a deliberately MINIMAL alias reusing the
        // OpenResponses mock body — NOT the OpenAI chat-completions shape.)
        if (pathname === "/v1/responses" || pathname === "/v1/chat/completions") {
          await handleChatRequest(req, res, deps);
          return;
        }
        res.statusCode = 404;
        res.end("Not Found");
      } catch {
        if (!res.writableEnded) {
          sendJson(res, 500, { error: { message: "internal error", type: "api_error" } });
        }
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(opts?.port ?? 0, host, resolve));
  const addr = server.address() as AddressInfo;
  const port = addr.port;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  };

  return {
    port,
    baseUrl: `http://${host}:${port}`,
    clerk,
    issuer: ISSUER,
    audience: AUDIENCE,
    mintBearer: (sub: string) => clerkBearer(sub, kp.privateKey),
    close,
  };
}

// --- CLI entrypoint ---------------------------------------------------------

async function main(): Promise<void> {
  const built = await startChatMockServer({ port: PORT });
  const base = built.baseUrl;
  const jwt = built.mintBearer(SUB);

  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "==========================================================================",
      "  openclaw chat MOCK server (channels-FREE, deterministic, NO LLM)",
      "==========================================================================",
      `  Base URL          : ${base}`,
      `  Canonical chat    : POST ${base}/v1/responses          (SSE, OpenResponses)`,
      `  Alias chat        : POST ${base}/v1/chat/completions    (same mock body)`,
      `  Auth mode         : REAL verifyClerkJwt (RS256/JWKS) — fail-closed 401`,
      `  Clerk issuer      : ${built.issuer}`,
      `  Clerk audience    : ${built.audience}`,
      `  Clerk JWKS        : ${built.clerk.jwksUrl}`,
      `  Stream delay      : ${STREAM_DELAY_MS}ms between deltas`,
      `  τ budget          : ${CLI_BUDGET === undefined ? "unlimited" : `${CLI_BUDGET} turn(s) per sub → 429 + Retry-After`}`,
      `  Demo sub          : ${SUB}  (scope = "${SUB}")`,
      CLI_LEGACY_TOKEN ? `  Legacy token      : "${CLI_LEGACY_TOKEN}" → 200, unscoped` : "",
      "==========================================================================",
      "",
      `# A ready-to-use Clerk JWT for QA (valid 1h, sub=${SUB}):`,
      `export CLERK_JWT='${jwt}'`,
      "",
      "# 1) HAPPY PATH — streamed SSE (named events; data: is the full event object):",
      `curl -N -sS ${base}/v1/responses \\`,
      `  -H "Authorization: Bearer $CLERK_JWT" \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'X-OpenClaw-Session-Key: thread-1' \\`,
      `  -d '{"model":"openclaw","input":"hello from mobile","stream":true}'`,
      "#   → response.created, response.in_progress, response.output_item.added,",
      "#     response.content_part.added, response.output_text.delta (x N),",
      "#     response.output_text.done, response.content_part.done,",
      "#     response.output_item.done, response.completed (usage), then data: [DONE]",
      "",
      "# 2) NON-STREAMING (single §2.3 JSON envelope):",
      `curl -sS ${base}/v1/responses \\`,
      `  -H "Authorization: Bearer $CLERK_JWT" \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"model":"openclaw","input":"hello","stream":false}'`,
      "",
      "# 3) AUTH FAIL-CLOSED — no / bad token → 401:",
      `curl -sS -o /dev/null -w 'no-token  → HTTP %{http_code}\\n' ${base}/v1/responses \\`,
      `  -H 'Content-Type: application/json' -d '{"model":"openclaw","input":"hi"}'`,
      `curl -sS -o /dev/null -w 'bad-token → HTTP %{http_code}\\n' ${base}/v1/responses \\`,
      `  -H 'Authorization: Bearer not.a.jwt' \\`,
      `  -H 'Content-Type: application/json' -d '{"model":"openclaw","input":"hi"}'`,
      "",
      "# 4) 429 path (only if started with --budget N):",
      `#   for i in $(seq 1 N+1); do curl ... ; done  → turn N+1 returns 429 + Retry-After`,
      "",
      "Ctrl-C to stop.",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  const shutdown = async () => {
    await built.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run as a script (not when imported by the test).
const isMain = process.argv[1]?.endsWith("chat-mock-server.ts");
if (isMain) {
  await main();
}
