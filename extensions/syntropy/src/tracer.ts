/**
 * Braintrust tracing seam for the syntropy extension — PHI-safe by default.
 *
 * This module is the ONLY place the extension shapes Braintrust spans. It is
 * intentionally decoupled from the `braintrust` SDK: the real `traced`
 * primitive is injected (see {@link createBraintrustTracer}) rather than
 * imported here, so:
 *
 *   - `client.ts` / `tools.ts` / `kg-tools.ts` stay 100% braintrust-free —
 *     they only ever see the small {@link Tracer} interface.
 *   - The default-OFF path loads NO braintrust code: when tracing is disabled
 *     the tool factories receive `undefined` and call the MCP transport
 *     directly (byte-identical behavior, zero spans, zero overhead).
 *
 * ⚠️ PHI SAFETY — the syntropy MCP calls carry health data (PHI). The default
 * span is METADATA-ONLY: `{ tool, label, ok, durationMs }`. Raw MCP args
 * (`input`) and results (`output`) are logged ONLY when `logContent` is true,
 * which sends PHI to the Braintrust cloud and is documented as QA /
 * synthetic-data ONLY.
 */

import type { McpToolResult } from "./client.js";

/**
 * The seam consumed by the tool factories. `traceMcp` runs `fn` (one MCP call)
 * and — when a real tracer is wired — wraps it in a Braintrust span. When the
 * tracer is absent (`undefined`), callers invoke `fn` directly.
 *
 * @param label     Caller label ("Syntropy", "kg-mcp", …) — span name prefix.
 * @param toolName  MCP tool name (e.g. "log_food").
 * @param args      Raw tool arguments. Attached to the span as `input` ONLY
 *                  when the tracer was built with `logContent: true` (PHI).
 * @param fn        The MCP call to execute + time.
 */
export interface Tracer {
  traceMcp<T extends McpToolResult>(
    label: string,
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Minimal local shape of the braintrust `traced` primitive. Declaring it here
 * (instead of importing `braintrust`) keeps typecheck from hard-depending on a
 * dep that may not be installed in every environment, and keeps the default-OFF
 * path free of any braintrust import.
 *
 * Matches `braintrust.traced(callback, args?)`:
 *   `traced<R>(cb: (span: TraceSpan) => R, args?: { name?: string }): Promise<R>`
 */
export interface TraceSpan {
  log(event: {
    metadata?: Record<string, unknown>;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  }): void;
}
export type TracedFn = <R>(
  callback: (span: TraceSpan) => R | Promise<R>,
  args?: { name?: string },
) => Promise<R>;

/**
 * Build a {@link Tracer} from the injected braintrust `traced` primitive.
 *
 * Span shape (default, metadata-only / PHI-safe):
 *   name     = `mcp.<toolName>`
 *   metadata = { tool, label, ok, durationMs }
 *
 * When `logContent` is true (QA / synthetic-data ONLY):
 *   input  = args (raw MCP arguments — PHI)
 *   output = result.data (raw MCP result — PHI)
 *
 * @param traced      The `braintrust.traced` function (lazy-imported by the
 *                    caller only on the enabled path).
 * @param logContent  When false (default), spans are metadata-only. When true,
 *                    raw MCP args/results are attached — PHI → Braintrust cloud.
 */
export function createBraintrustTracer(traced: TracedFn, logContent: boolean): Tracer {
  return {
    traceMcp<T extends McpToolResult>(
      label: string,
      toolName: string,
      args: Record<string, unknown>,
      fn: () => Promise<T>,
    ): Promise<T> {
      return traced(
        async (span) => {
          const start = Date.now();
          const result = await fn();
          const durationMs = Date.now() - start;

          const event: {
            metadata: Record<string, unknown>;
            input?: unknown;
            output?: unknown;
            error?: unknown;
          } = {
            metadata: {
              tool: toolName,
              label,
              ok: result.ok,
              durationMs,
            },
          };
          if (logContent) {
            // PHI path — explicit opt-in only.
            event.input = args;
            event.output = result.data;
          }
          if (!result.ok && result.error) {
            event.error = result.error;
          }
          span.log(event);
          return result;
        },
        { name: `mcp.${toolName}` },
      );
    },
  };
}
