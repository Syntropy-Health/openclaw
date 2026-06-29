/**
 * Braintrust tracer-seam tests — PHI-safe span shape.
 *
 * The tracer is built from a fake `traced` primitive (the same shape as
 * `braintrust.traced`) so we can assert exactly what gets logged to a span,
 * without a real braintrust login. Covers:
 *   - metadata-only default (NO raw args/result) → PHI-safe
 *   - logContent=true → input=args, output=result.data attached (PHI opt-in)
 *   - span name = mcp.<toolName>
 *   - error attached only on failure
 *   - the tracer returns the wrapped call's result unchanged
 */

import { describe, expect, it, vi } from "vitest";
import type { McpToolResult } from "./client.js";
import { createBraintrustTracer, type TraceSpan, type TracedFn } from "./tracer.js";

/** A fake `traced` that records the span name + the single logged event. */
function fakeTraced() {
  const logged: Array<{
    name?: string;
    event: Parameters<TraceSpan["log"]>[0];
  }> = [];
  const traced: TracedFn = async (callback, args) => {
    let captured: Parameters<TraceSpan["log"]>[0] = {};
    const span: TraceSpan = {
      log(event) {
        captured = event;
      },
    };
    const result = await callback(span);
    logged.push({ name: args?.name, event: captured });
    return result;
  };
  return { traced, logged };
}

const okResult: McpToolResult = { ok: true, data: { score: 42 } };
const errResult: McpToolResult = { ok: false, data: null, error: "boom" };

describe("createBraintrustTracer — metadata-only (default, PHI-safe)", () => {
  it("logs span name mcp.<tool> with metadata {tool,label,ok,durationMs} and NO raw args/result", async () => {
    const { traced, logged } = fakeTraced();
    const tracer = createBraintrustTracer(traced, /* logContent */ false);

    const args = { food_name: "secret-PHI-meal", calories: 600 };
    const result = await tracer.traceMcp("Syntropy", "log_food", args, async () => okResult);

    expect(result).toBe(okResult); // result passes through unchanged
    expect(logged).toHaveLength(1);
    const { name, event } = logged[0]!;
    expect(name).toBe("mcp.log_food");
    expect(event.metadata).toMatchObject({ tool: "log_food", label: "Syntropy", ok: true });
    expect(typeof event.metadata?.durationMs).toBe("number");
    // PHI guard: no raw args or result anywhere in the span.
    expect(event.input).toBeUndefined();
    expect(event.output).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("secret-PHI-meal");
  });

  it("attaches error (not output) when the call fails", async () => {
    const { traced, logged } = fakeTraced();
    const tracer = createBraintrustTracer(traced, false);

    const result = await tracer.traceMcp(
      "kg-mcp",
      "kg_food_to_bioactives",
      {},
      async () => errResult,
    );

    expect(result).toBe(errResult);
    const { event } = logged[0]!;
    expect(event.metadata).toMatchObject({ ok: false });
    expect(event.error).toBe("boom");
    expect(event.output).toBeUndefined();
  });
});

describe("createBraintrustTracer — logContent=true (PHI opt-in, QA/synthetic only)", () => {
  it("attaches input=args and output=result.data", async () => {
    const { traced, logged } = fakeTraced();
    const tracer = createBraintrustTracer(traced, /* logContent */ true);

    const args = { food_name: "synthetic-meal" };
    await tracer.traceMcp("Syntropy", "log_food", args, async () => okResult);

    const { event } = logged[0]!;
    expect(event.input).toEqual(args);
    expect(event.output).toEqual(okResult.data);
    expect(event.metadata).toMatchObject({ tool: "log_food", ok: true });
  });
});

describe("tracer integration with the tool factory", () => {
  it("createAllTools routes each MCP call through traceMcp when a tracer is supplied", async () => {
    // Mock the SJ HTTP client so we don't hit the network.
    vi.resetModules();
    const callSyntropyTool = vi.fn(async () => okResult);
    vi.doMock("./client.js", () => ({ callSyntropyTool }));

    const { createAllTools } = await import("./tools.js");
    const spy = vi.fn();
    const tracer = {
      traceMcp<T extends McpToolResult>(
        label: string,
        tool: string,
        args: Record<string, unknown>,
        fn: () => Promise<T>,
      ): Promise<T> {
        spy(label, tool, args);
        return fn();
      },
    };
    const tools = createAllTools("http://x", "sj_tok", tracer);
    const logFood = tools.find((t) => t.name === "syntropy_log_food")!;

    await logFood.execute("call-1", { food_name: "apple" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [label, tool, args] = spy.mock.calls[0]!;
    expect(label).toBe("Syntropy");
    expect(tool).toBe("log_food");
    expect(args).toEqual({ food_name: "apple" });
    expect(callSyntropyTool).toHaveBeenCalledWith("http://x", "sj_tok", "log_food", {
      food_name: "apple",
    });

    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  it("createAllTools default-OFF: no tracer → calls client directly, result identical", async () => {
    vi.resetModules();
    const callSyntropyTool = vi.fn(async () => okResult);
    vi.doMock("./client.js", () => ({ callSyntropyTool }));

    const { createAllTools } = await import("./tools.js");
    const tools = createAllTools("http://x", "sj_tok"); // no tracer
    const logFood = tools.find((t) => t.name === "syntropy_log_food")!;

    const res = await logFood.execute("call-1", { food_name: "apple" });
    expect(callSyntropyTool).toHaveBeenCalledTimes(1);
    // result is the toAgentResult-wrapped success
    expect(res.content[0]).toMatchObject({ type: "text" });

    vi.doUnmock("./client.js");
    vi.resetModules();
  });
});
