/**
 * OpenResponses HTTP Handler
 *
 * Implements the OpenResponses `/v1/responses` endpoint for OpenClaw Gateway.
 *
 * @see https://www.open-responses.com/
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientToolDefinition } from "../agents/pi-embedded-runner/run/params.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { ImageContent } from "../commands/agent/types.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractFileContentFromSource,
  extractImageContentFromSource,
  normalizeMimeList,
  resolveInputFileLimits,
  type InputFileLimits,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  parseComponentDescriptor,
  type ComponentDescriptor,
} from "./component-descriptor.schema.js";
import { sendJson, sendRateLimited, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  deriveUserScopeFromSub,
  resolveAgentIdForRequest,
  resolveChannelFromHeader,
  resolveSessionKey,
} from "./http-utils.js";
import {
  CreateResponseBodySchema,
  type ContentPart,
  type CreateResponseBody,
  type ItemParam,
  type OutputItem,
  type ResponseResource,
  type StreamingEvent,
  type Usage,
} from "./open-responses.schema.js";
import type { TauMeter } from "./tau-meter.js";

type OpenResponsesHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  config?: GatewayHttpResponsesConfig;
  trustedProxies?: string[];
  rateLimiter?: AuthRateLimiter;
  /** Per-user_scope τ budget meter (§9). No-op for non-Clerk requests. */
  tauMeter?: TauMeter;
};

const DEFAULT_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_URL_PARTS = 8;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/**
 * Fallback assistant text when a turn produced no narration and no component
 * degradation floor applies. Also the sentinel the ui.summary floor treats as
 * "empty" (see applyComponentSummaryFloor).
 */
const NO_RESPONSE_SENTINEL = "No response from OpenClaw.";

/**
 * Max ComponentDescriptors lifted from one turn's reply-payload channelData
 * (SEC-1 bound, compromised-backend threat model): extras beyond the cap are
 * dropped, never thrown.
 */
const MAX_COMPONENTS_PER_TURN = 8;

/** Sentinel returned by withTurnTimeout when the per-turn deadline fires first. */
const TURN_TIMEOUT = Symbol("openresponses-turn-timeout");

/**
 * Race an agent-run promise against a hard per-turn deadline. Resolves to
 * TURN_TIMEOUT if the deadline fires first (the underlying run is abandoned — the
 * caller surfaces a failure and stops waiting). ms <= 0 disables the timeout.
 */
function withTurnTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TURN_TIMEOUT> {
  if (!ms || ms <= 0) {
    return p;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TURN_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TURN_TIMEOUT), ms);
  });
  return Promise.race([
    p.then((v) => {
      if (timer) {
        clearTimeout(timer);
      }
      return v;
    }),
    timeout,
  ]);
}

function writeSseEvent(res: ServerResponse, event: StreamingEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "input_text") {
        return part.text;
      }
      if (part.type === "output_text") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

type ResolvedResponsesLimits = {
  maxBodyBytes: number;
  maxUrlParts: number;
  turnTimeoutMs: number;
  files: InputFileLimits;
  images: InputImageLimits;
};

function normalizeHostnameAllowlist(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveResponsesLimits(
  config: GatewayHttpResponsesConfig | undefined,
): ResolvedResponsesLimits {
  const files = config?.files;
  const images = config?.images;
  const fileLimits = resolveInputFileLimits(files);
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    maxUrlParts:
      typeof config?.maxUrlParts === "number"
        ? Math.max(0, Math.floor(config.maxUrlParts))
        : DEFAULT_MAX_URL_PARTS,
    turnTimeoutMs:
      typeof config?.turnTimeoutMs === "number"
        ? Math.max(0, Math.floor(config.turnTimeoutMs))
        : DEFAULT_TURN_TIMEOUT_MS,
    files: {
      ...fileLimits,
      urlAllowlist: normalizeHostnameAllowlist(files?.urlAllowlist),
    },
    images: {
      allowUrl: images?.allowUrl ?? true,
      urlAllowlist: normalizeHostnameAllowlist(images?.urlAllowlist),
      allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: images?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: images?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: images?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function extractClientTools(body: CreateResponseBody): ClientToolDefinition[] {
  return (body.tools ?? []) as ClientToolDefinition[];
}

function applyToolChoice(params: {
  tools: ClientToolDefinition[];
  toolChoice: CreateResponseBody["tool_choice"];
}): { tools: ClientToolDefinition[]; extraSystemPrompt?: string } {
  const { tools, toolChoice } = params;
  if (!toolChoice) {
    return { tools };
  }

  if (toolChoice === "none") {
    return { tools: [] };
  }

  if (toolChoice === "required") {
    if (tools.length === 0) {
      throw new Error("tool_choice=required but no tools were provided");
    }
    return {
      tools,
      extraSystemPrompt: "You must call one of the available tools before responding.",
    };
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const targetName = toolChoice.function?.name?.trim();
    if (!targetName) {
      throw new Error("tool_choice.function.name is required");
    }
    const matched = tools.filter((tool) => tool.function?.name === targetName);
    if (matched.length === 0) {
      throw new Error(`tool_choice requested unknown tool: ${targetName}`);
    }
    return {
      tools: matched,
      extraSystemPrompt: `You must call the ${targetName} tool before responding.`,
    };
  }

  return { tools };
}

export function buildAgentPrompt(input: string | ItemParam[]): {
  message: string;
  extraSystemPrompt?: string;
} {
  if (typeof input === "string") {
    return { message: input };
  }

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const item of input) {
    if (item.type === "message") {
      const content = extractTextContent(item.content).trim();
      if (!content) {
        continue;
      }

      if (item.role === "system" || item.role === "developer") {
        systemParts.push(content);
        continue;
      }

      const normalizedRole = item.role === "assistant" ? "assistant" : "user";
      const sender = normalizedRole === "assistant" ? "Assistant" : "User";

      conversationEntries.push({
        role: normalizedRole,
        entry: { sender, body: content },
      });
    } else if (item.type === "function_call_output") {
      conversationEntries.push({
        role: "tool",
        entry: { sender: `Tool:${item.call_id}`, body: item.output },
      });
    }
    // Skip reasoning and item_reference for prompt building (Phase 1)
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenResponsesSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  userScope?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openresponses" });
}

function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

/**
 * τ cost charged for one completed turn: the turn's `total_tokens` when the
 * runtime reported a positive count, else `1` (count the turn). This lets the
 * §9 budget throttle on real τ spend when usage is available and on request
 * rate otherwise — either way a completed turn always consumes at least 1.
 */
function tauTurnCost(usage: Usage | undefined): number {
  const total = usage?.total_tokens;
  return typeof total === "number" && total > 0 ? total : 1;
}

function toUsage(
  value:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined,
): Usage {
  if (!value) {
    return createEmptyUsage();
  }
  const input = value.input ?? 0;
  const output = value.output ?? 0;
  const cacheRead = value.cacheRead ?? 0;
  const cacheWrite = value.cacheWrite ?? 0;
  const total = value.total ?? input + output + cacheRead + cacheWrite;
  return {
    input_tokens: Math.max(0, input),
    output_tokens: Math.max(0, output),
    total_tokens: Math.max(0, total),
  };
}

function extractUsageFromResult(result: unknown): Usage {
  const meta = (result as { meta?: { agentMeta?: { usage?: unknown } } } | null)?.meta;
  const usage = meta && typeof meta === "object" ? meta.agentMeta?.usage : undefined;
  return toUsage(
    usage as
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
      | undefined,
  );
}

/**
 * Detect an agent-run failure from the agent command result so the chat path can
 * surface it as the contract's failure envelope (status:"failed" + error{code,message}
 * / a `response.failed` SSE event) instead of a silent completed-200 placeholder.
 *
 * Signals (see EmbeddedPiRunMeta):
 *  - `meta.error` — a structured non-recoverable run error (context_overflow,
 *    compaction_failure, role_ordering, image_size).
 *  - all `payloads` are error items (`isError`) with no successful content — i.e.
 *    the agent surfaced a model/provider error (LM Studio 401, auth, rate-limit,
 *    billing) as its only output.
 *
 * Returns null for a genuinely empty-but-successful turn (no payloads, no error)
 * so legitimate empty completions are NOT turned into errors (conservative).
 */
function detectAgentRunFailure(result: unknown): { code: string; message: string } | null {
  const r = result as {
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { error?: { kind?: string; message?: string } };
  } | null;

  const runError = r?.meta?.error;
  if (runError?.kind || runError?.message) {
    return {
      code: runError.kind ?? "agent_error",
      message: runError.message || runError.kind || "agent run failed",
    };
  }

  const payloads = Array.isArray(r?.payloads) ? r.payloads : [];
  const hasRealContent = payloads.some(
    (p) => typeof p.text === "string" && p.text.trim().length > 0 && !p.isError,
  );
  if (hasRealContent) {
    return null;
  }

  const errorTexts = payloads
    .filter((p) => p.isError && typeof p.text === "string" && p.text.trim().length > 0)
    .map((p) => (p.text as string).trim());
  if (errorTexts.length > 0) {
    return { code: "agent_error", message: errorTexts.join("\n\n") };
  }

  return null;
}

function createResponseResource(params: {
  id: string;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? createEmptyUsage(),
    error: params.error,
  };
}

function createAssistantOutputItem(params: {
  id: string;
  text: string;
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    status: params.status,
  };
}

function createComponentOutputItem(params: {
  id: string;
  component: ComponentDescriptor;
}): OutputItem {
  return {
    type: "component",
    id: params.id,
    component: params.component,
  };
}

/**
 * Lift ComponentDescriptors (C1 contract) that ride in reply payloads'
 * `channelData` (wire shape `{ type: "component", component: <descriptor> }`).
 * A payload whose channelData is not a component, or whose descriptor fails to
 * parse, is dropped silently — never crashes the chat path.
 */
function extractComponentDescriptors(payloads: unknown): ComponentDescriptor[] {
  if (!Array.isArray(payloads)) {
    return [];
  }
  const descriptors: ComponentDescriptor[] = [];
  for (const payload of payloads) {
    const channelData = (payload as { channelData?: unknown } | null | undefined)?.channelData;
    if (!channelData || typeof channelData !== "object") {
      continue;
    }
    const carrier = channelData as { type?: unknown; component?: unknown };
    if (carrier.type !== "component") {
      continue;
    }
    const descriptor = parseComponentDescriptor(carrier.component);
    if (descriptor) {
      descriptors.push(descriptor);
      // SEC-1 bound: never lift more than the cap from one turn (a compromised
      // backend must not be able to flood the client with components).
      if (descriptors.length >= MAX_COMPONENTS_PER_TURN) {
        break;
      }
    }
  }
  return descriptors;
}

/**
 * ui.summary degradation floor (A&D D5 / Component 5 / R4): when the LLM produced
 * no narration (empty text or the no-response sentinel) but at least one component
 * was lifted, seed the assistant message text from the FIRST descriptor's
 * `ui.summary` so a non-component-aware client still shows the confirmation text.
 * When the LLM already narrated real text, keep it verbatim (never append or
 * double-narrate). Applied identically on the stream + non-stream paths.
 */
function applyComponentSummaryFloor(text: string, components: ComponentDescriptor[]): string {
  if ((text.length === 0 || text === NO_RESPONSE_SENTINEL) && components.length > 0) {
    return components[0].ui.summary;
  }
  return text;
}

async function runResponsesAgentCommand(params: {
  message: string;
  images: ImageContent[];
  clientTools: ClientToolDefinition[];
  extraSystemPrompt: string;
  streamParams: { maxTokens: number } | undefined;
  sessionKey: string;
  /** Verified external caller identity (Clerk JWT `sub`); threaded to memory-graphiti (#834/#836). */
  externalId: string | null;
  runId: string;
  /** Presentation-only channel (allowlisted; defaults to "webchat"). */
  channel?: string;
  deps: ReturnType<typeof createDefaultDeps>;
}) {
  return agentCommand(
    {
      message: params.message,
      images: params.images.length > 0 ? params.images : undefined,
      clientTools: params.clientTools.length > 0 ? params.clientTools : undefined,
      extraSystemPrompt: params.extraSystemPrompt || undefined,
      streamParams: params.streamParams ?? undefined,
      sessionKey: params.sessionKey,
      externalId: params.externalId,
      runId: params.runId,
      deliver: false,
      messageChannel: params.channel ?? "webchat",
      bestEffortDeliver: false,
    },
    defaultRuntime,
    params.deps,
  );
}

export async function handleOpenResponsesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenResponsesHttpOptions,
): Promise<boolean> {
  const limits = resolveResponsesLimits(opts.config);
  const maxBodyBytes =
    opts.maxBodyBytes ??
    (opts.config?.maxBodyBytes
      ? limits.maxBodyBytes
      : Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2));
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/responses",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  // Validate request body with Zod
  const parseResult = CreateResponseBodySchema.safeParse(handled.body);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const message = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body";
    sendJson(res, 400, {
      error: { message, type: "invalid_request_error" },
    });
    return true;
  }

  const payload: CreateResponseBody = parseResult.data;
  const stream = Boolean(payload.stream);
  const model = payload.model;
  const user = payload.user;

  // Extract images + files from input (Phase 2)
  let images: ImageContent[] = [];
  let fileContexts: string[] = [];
  let urlParts = 0;
  const markUrlPart = () => {
    urlParts += 1;
    if (urlParts > limits.maxUrlParts) {
      throw new Error(
        `Too many URL-based input sources: ${urlParts} (limit: ${limits.maxUrlParts})`,
      );
    }
  };
  try {
    if (Array.isArray(payload.input)) {
      for (const item of payload.input) {
        if (item.type === "message" && typeof item.content !== "string") {
          for (const part of item.content) {
            if (part.type === "input_image") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_image must have 'source.url' or 'source.data'");
              }
              if (sourceType === "url") {
                markUrlPart();
              }
              const imageSource: InputImageSource = {
                type: sourceType,
                url: source.url,
                data: source.data,
                mediaType: source.media_type,
              };
              const image = await extractImageContentFromSource(imageSource, limits.images);
              images.push(image);
              continue;
            }

            if (part.type === "input_file") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
                filename?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_file must have 'source.url' or 'source.data'");
              }
              if (sourceType === "url") {
                markUrlPart();
              }
              const file = await extractFileContentFromSource({
                source: {
                  type: sourceType,
                  url: source.url,
                  data: source.data,
                  mediaType: source.media_type,
                  filename: source.filename,
                },
                limits: limits.files,
              });
              if (file.text?.trim()) {
                fileContexts.push(`<file name="${file.filename}">\n${file.text}\n</file>`);
              } else if (file.images && file.images.length > 0) {
                fileContexts.push(
                  `<file name="${file.filename}">[PDF content rendered to images]</file>`,
                );
              }
              if (file.images && file.images.length > 0) {
                images = images.concat(file.images);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logWarn(`openresponses: request parsing failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid request", type: "invalid_request_error" },
    });
    return true;
  }

  const clientTools = extractClientTools(payload);
  let toolChoicePrompt: string | undefined;
  let resolvedClientTools = clientTools;
  try {
    const toolChoiceResult = applyToolChoice({
      tools: clientTools,
      toolChoice: payload.tool_choice,
    });
    resolvedClientTools = toolChoiceResult.tools;
    toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
  } catch (err) {
    logWarn(`openresponses: tool configuration failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid tool configuration", type: "invalid_request_error" },
    });
    return true;
  }
  const agentId = resolveAgentIdForRequest({ req, model });
  // L1 user_scope is server-derived from the verified Clerk `sub` (never the
  // client-sent `user` field). When present it partitions the session/memory.
  const userScope = deriveUserScopeFromSub(handled.externalId);
  const sessionKey = resolveOpenResponsesSessionKey({ req, agentId, user, userScope });
  // Presentation-only channel (allowlisted). Feeds messageChannel ONLY — never
  // auth/externalId/userScope/sessionKey (A&D §S10). Unknown/absent ⇒ webchat.
  const channel = resolveChannelFromHeader(req) ?? "webchat";

  // τ-metering (§9): per-user_scope budget. No-op for non-Clerk requests
  // (userScope undefined). On exhaustion → 429 + Retry-After, before any agent
  // run, so an exhausted user is never charged a turn.
  const tauCheck = opts.tauMeter?.check(userScope);
  if (tauCheck && !tauCheck.allowed) {
    sendRateLimited(res, tauCheck.retryAfterMs);
    return true;
  }

  // Build prompt from input
  const prompt = buildAgentPrompt(payload.input);

  const fileContext = fileContexts.length > 0 ? fileContexts.join("\n\n") : undefined;
  const toolChoiceContext = toolChoicePrompt?.trim();

  // Handle instructions + file context as extra system prompt
  const extraSystemPrompt = [
    payload.instructions,
    prompt.extraSystemPrompt,
    toolChoiceContext,
    fileContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `input`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const responseId = `resp_${randomUUID()}`;
  const outputItemId = `msg_${randomUUID()}`;
  const deps = createDefaultDeps();
  const streamParams =
    typeof payload.max_output_tokens === "number"
      ? { maxTokens: payload.max_output_tokens }
      : undefined;

  if (!stream) {
    try {
      const result = await withTurnTimeout(
        runResponsesAgentCommand({
          message: prompt.message,
          images,
          clientTools: resolvedClientTools,
          extraSystemPrompt,
          streamParams,
          sessionKey,
          externalId: handled.externalId ?? null,
          runId: responseId,
          channel,
          deps,
        }),
        limits.turnTimeoutMs,
      );

      // Hard per-turn timeout (issue #112): a hung/looping model call must never
      // hang the chat path — surface the contract failure envelope instead.
      if (result === TURN_TIMEOUT) {
        logWarn(`openresponses: turn timed out after ${limits.turnTimeoutMs}ms (non-stream)`);
        const timeoutResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: "timeout",
            message: `agent run exceeded ${limits.turnTimeoutMs}ms`,
          },
          usage: createEmptyUsage(),
        });
        sendJson(res, 200, timeoutResponse);
        return true;
      }

      const payloads = (
        result as {
          payloads?: Array<{ text?: string; channelData?: Record<string, unknown> }>;
        } | null
      )?.payloads;
      const usage = extractUsageFromResult(result);
      // Record τ spend for the budget (turn count when usage is absent).
      opts.tauMeter?.record(userScope, tauTurnCost(usage));
      const meta = (result as { meta?: unknown } | null)?.meta;
      const stopReason =
        meta && typeof meta === "object" ? (meta as { stopReason?: string }).stopReason : undefined;
      const pendingToolCalls =
        meta && typeof meta === "object"
          ? (meta as { pendingToolCalls?: Array<{ id: string; name: string; arguments: string }> })
              .pendingToolCalls
          : undefined;

      // If agent called a client tool, return function_call instead of text
      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        const functionCall = pendingToolCalls[0];
        const functionCallItemId = `call_${randomUUID()}`;
        const response = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [
            {
              type: "function_call",
              id: functionCallItemId,
              call_id: functionCall.id,
              name: functionCall.name,
              arguments: functionCall.arguments,
            },
          ],
          usage,
        });
        sendJson(res, 200, response);
        return true;
      }

      // Surface an agent-run failure as the contract failure envelope (§85/§99)
      // instead of a silent completed-200 placeholder.
      const failure = detectAgentRunFailure(result);
      if (failure) {
        logWarn(`openresponses: agent run failed (${failure.code}): ${failure.message}`);
        const failedResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: { code: failure.code, message: failure.message },
          usage,
        });
        sendJson(res, 200, failedResponse);
        return true;
      }

      // Lift any ComponentDescriptors riding in payload channelData into
      // additive `component` output items (T3.1).
      const descriptors = extractComponentDescriptors(payloads);
      const joinedText =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : NO_RESPONSE_SENTINEL;
      // ui.summary degradation floor (DESIGN-1): seed message text from the first
      // descriptor's summary when the LLM narrated nothing, so a component-only
      // turn never renders as the empty/sentinel placeholder.
      const content = applyComponentSummaryFloor(joinedText, descriptors);

      const componentItems = descriptors.map((component) =>
        createComponentOutputItem({ id: `comp_${randomUUID()}`, component }),
      );

      const response = createResponseResource({
        id: responseId,
        model,
        status: "completed",
        output: [
          createAssistantOutputItem({ id: outputItemId, text: content, status: "completed" }),
          ...componentItems,
        ],
        usage,
      });

      sendJson(res, 200, response);
    } catch (err) {
      logWarn(`openresponses: non-stream response failed: ${String(err)}`);
      const response = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
      });
      sendJson(res, 500, response);
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming mode
  // ─────────────────────────────────────────────────────────────────────────

  setSseHeaders(res);

  let accumulatedText = "";
  let sawAssistantDelta = false;
  let closed = false;
  let unsubscribe = () => {};
  let finalUsage: Usage | undefined;
  let finalizeRequested: { status: ResponseResource["status"]; text: string } | null = null;
  let finalError: { code: string; message: string } | null = null;
  // ComponentDescriptors lifted from the final payloads' channelData (T3.1),
  // captured where finalUsage is set (see the async run block below). Emitted as
  // additive `component` output items on the success terminal only.
  let finalComponents: ComponentDescriptor[] = [];

  const maybeFinalize = () => {
    if (closed) {
      return;
    }
    if (!finalizeRequested) {
      return;
    }
    if (!finalUsage) {
      return;
    }
    const usage = finalUsage;

    closed = true;
    unsubscribe();

    // Record τ spend for the budget once the streamed turn is finalized (success
    // or failure — a turn that ran consumed budget either way).
    opts.tauMeter?.record(userScope, tauTurnCost(usage));

    // Failure terminal (contract §85/§99): emit `response.failed` with the error
    // envelope, NOT `response.completed`, so clients can distinguish an agent-run
    // failure from a real reply.
    if (finalizeRequested.status === "failed") {
      const failedResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: finalError ?? {
          code: "agent_error",
          message: finalizeRequested.text || "agent run failed",
        },
        usage,
      });
      writeSseEvent(res, { type: "response.failed", response: failedResponse });
      writeDone(res);
      res.end();
      return;
    }

    // ui.summary degradation floor (DESIGN-1): finalComponents is guaranteed set
    // here (set alongside finalUsage, which gates this success terminal), so a
    // component-only turn seeds the message text from the first descriptor's
    // summary rather than the empty/sentinel placeholder. Identical to non-stream.
    const finalText = applyComponentSummaryFloor(finalizeRequested.text, finalComponents);

    writeSseEvent(res, {
      type: "response.output_text.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      text: finalText,
    });

    writeSseEvent(res, {
      type: "response.content_part.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: finalText },
    });

    const completedItem = createAssistantOutputItem({
      id: outputItemId,
      text: finalText,
      status: "completed",
    });

    writeSseEvent(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedItem,
    });

    // Additive `component` output items (T3.1) at output_index 1,2,… — mirrors the
    // function_call streaming block. Success terminal only; none on failure.
    const componentItems = finalComponents.map((component) =>
      createComponentOutputItem({ id: `comp_${randomUUID()}`, component }),
    );
    componentItems.forEach((item, offset) => {
      const outputIndex = offset + 1;
      writeSseEvent(res, {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      });
      writeSseEvent(res, {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      });
    });

    const finalResponse = createResponseResource({
      id: responseId,
      model,
      status: finalizeRequested.status,
      output: [completedItem, ...componentItems],
      usage,
    });

    writeSseEvent(res, { type: "response.completed", response: finalResponse });
    writeDone(res);
    res.end();
  };

  const requestFinalize = (status: ResponseResource["status"], text: string) => {
    if (finalizeRequested) {
      return;
    }
    finalizeRequested = { status, text };
    maybeFinalize();
  };

  // Send initial events
  const initialResponse = createResponseResource({
    id: responseId,
    model,
    status: "in_progress",
    output: [],
  });

  writeSseEvent(res, { type: "response.created", response: initialResponse });
  writeSseEvent(res, { type: "response.in_progress", response: initialResponse });

  // Add output item
  const outputItem = createAssistantOutputItem({
    id: outputItemId,
    text: "",
    status: "in_progress",
  });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: outputItem,
  });

  // Add content part
  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== responseId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        return;
      }

      sawAssistantDelta = true;
      accumulatedText += content;

      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        const finalText = accumulatedText || NO_RESPONSE_SENTINEL;
        const finalStatus = phase === "error" ? "failed" : "completed";
        requestFinalize(finalStatus, finalText);
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await withTurnTimeout(
        runResponsesAgentCommand({
          message: prompt.message,
          images,
          clientTools: resolvedClientTools,
          extraSystemPrompt,
          streamParams,
          sessionKey,
          externalId: handled.externalId ?? null,
          runId: responseId,
          channel,
          deps,
        }),
        limits.turnTimeoutMs,
      );

      // Hard per-turn timeout (issue #112): emit the contract `response.failed`
      // terminal instead of leaving the SSE stream open on a hung/looping run.
      if (result === TURN_TIMEOUT) {
        if (closed) {
          return;
        }
        logWarn(`openresponses: turn timed out after ${limits.turnTimeoutMs}ms (stream)`);
        finalError = { code: "timeout", message: `agent run exceeded ${limits.turnTimeoutMs}ms` };
        finalUsage = createEmptyUsage();
        finalizeRequested = { status: "failed", text: finalError.message };
        maybeFinalize();
        return;
      }

      finalUsage = extractUsageFromResult(result);
      // Capture ComponentDescriptors from the resolved payloads' channelData so
      // the success terminal (maybeFinalize) can emit them (T3.1). maybeFinalize
      // never proceeds until finalUsage is set, so this runs before it finalizes.
      finalComponents = extractComponentDescriptors(
        (result as { payloads?: unknown } | null)?.payloads,
      );

      // Surface an agent-run failure as the contract `response.failed` terminal
      // (§85/§99) instead of dressing the error up as a completed reply. Force the
      // finalize status to "failed" even if a lifecycle "end" already requested a
      // completed finalize during the run.
      const failure = detectAgentRunFailure(result);
      if (failure) {
        logWarn(`openresponses: streaming agent run failed (${failure.code}): ${failure.message}`);
        finalError = failure;
        finalizeRequested = { status: "failed", text: failure.message };
        maybeFinalize();
        return;
      }

      maybeFinalize();

      if (closed) {
        return;
      }

      // Fallback: if no streaming deltas were received, send the full response
      if (!sawAssistantDelta) {
        const resultAny = result as { payloads?: Array<{ text?: string }>; meta?: unknown };
        const payloads = resultAny.payloads;
        const meta = resultAny.meta;
        const stopReason =
          meta && typeof meta === "object"
            ? (meta as { stopReason?: string }).stopReason
            : undefined;
        const pendingToolCalls =
          meta && typeof meta === "object"
            ? (
                meta as {
                  pendingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
                }
              ).pendingToolCalls
            : undefined;

        // If agent called a client tool, emit function_call instead of text
        if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
          const functionCall = pendingToolCalls[0];
          const usage = finalUsage ?? createEmptyUsage();

          writeSseEvent(res, {
            type: "response.output_text.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            text: "",
          });
          writeSseEvent(res, {
            type: "response.content_part.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          });

          const completedItem = createAssistantOutputItem({
            id: outputItemId,
            text: "",
            status: "completed",
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: 0,
            item: completedItem,
          });

          const functionCallItemId = `call_${randomUUID()}`;
          const functionCallItem = {
            type: "function_call" as const,
            id: functionCallItemId,
            call_id: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          };
          writeSseEvent(res, {
            type: "response.output_item.added",
            output_index: 1,
            item: functionCallItem,
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: 1,
            item: { ...functionCallItem, status: "completed" as const },
          });

          const incompleteResponse = createResponseResource({
            id: responseId,
            model,
            status: "incomplete",
            output: [completedItem, functionCallItem],
            usage,
          });
          closed = true;
          unsubscribe();
          writeSseEvent(res, { type: "response.completed", response: incompleteResponse });
          writeDone(res);
          res.end();
          return;
        }

        const joinedText =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : NO_RESPONSE_SENTINEL;
        // Apply the ui.summary floor here too (finalComponents already captured
        // above) so the emitted delta matches the terminal message text.
        const content = applyComponentSummaryFloor(joinedText, finalComponents);

        accumulatedText = content;
        sawAssistantDelta = true;

        writeSseEvent(res, {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta: content,
        });
      }
    } catch (err) {
      logWarn(`openresponses: streaming response failed: ${String(err)}`);
      if (closed) {
        return;
      }

      finalUsage = finalUsage ?? createEmptyUsage();
      const errorResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
        usage: finalUsage,
      });

      writeSseEvent(res, { type: "response.failed", response: errorResponse });
      // Mark closed + unsubscribe BEFORE re-emitting lifecycle events so the
      // error/end events below cannot re-enter maybeFinalize() and emit a second
      // terminal event for this same response.
      closed = true;
      unsubscribe();
      writeDone(res);
      res.end();
      emitAgentEvent({
        runId: responseId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        // Emit lifecycle end to trigger completion
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}
