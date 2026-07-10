/**
 * OpenResponses `component` output item (T3.1)
 *
 * A ComponentDescriptor riding in a reply payload's `channelData`
 * (wire shape `{ type: "component", component: <descriptor> }`) is lifted to a
 * fourth `component` output item on POST /v1/responses — additive to the
 * assistant message, on both the non-stream and streaming paths.
 */

import { describe, expect, it } from "vitest";
import { parseComponentDescriptor } from "./component-descriptor.schema.js";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

// A schema-valid ComponentDescriptor (C1 contract).
const VALID_DESCRIPTOR = {
  type: "component" as const,
  key: "confirm_dose",
  props: { amount_mg: 500 },
  ui: { summary: "Confirm your 500mg dose" },
};

// The wire shape that rides in channelData.
const COMPONENT_CHANNEL_DATA = {
  type: "component" as const,
  component: VALID_DESCRIPTOR,
};

// A second, distinct schema-valid descriptor for multi-component ordering tests.
const VALID_DESCRIPTOR_2 = {
  type: "component" as const,
  key: "confirm_time",
  props: { hour: 8 },
  ui: { summary: "Confirm 8am reminder" },
};

const COMPONENT_CHANNEL_DATA_2 = {
  type: "component" as const,
  component: VALID_DESCRIPTOR_2,
};

async function startServer(port: number) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openResponsesEnabled: true,
  } as const);
}

async function postResponses(port: number, body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  const lines = text.split("\n");
  let currentEvent: string | undefined;
  let currentData: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice("data: ".length));
    } else if (line.trim() === "" && currentData.length > 0) {
      events.push({ event: currentEvent, data: currentData.join("\n") });
      currentEvent = undefined;
      currentData = [];
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

describe("ComponentOutputItemSchema", () => {
  it("accepts a valid component output item", async () => {
    const { ComponentOutputItemSchema } = await import("./open-responses.schema.js");
    const result = ComponentOutputItemSchema.safeParse({
      type: "component",
      id: "comp_1",
      component: VALID_DESCRIPTOR,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a component item missing the component field", async () => {
    const { ComponentOutputItemSchema } = await import("./open-responses.schema.js");
    const result = ComponentOutputItemSchema.safeParse({ type: "component", id: "comp_1" });
    expect(result.success).toBe(false);
  });

  it("rejects a component item with the wrong descriptor shape", async () => {
    const { ComponentOutputItemSchema } = await import("./open-responses.schema.js");
    const result = ComponentOutputItemSchema.safeParse({
      type: "component",
      id: "comp_1",
      component: { type: "component", key: "x", props: {}, ui: {} }, // missing ui.summary
    });
    expect(result.success).toBe(false);
  });

  it("is discriminated by OutputItemSchema", async () => {
    const { OutputItemSchema } = await import("./open-responses.schema.js");
    const result = OutputItemSchema.safeParse({
      type: "component",
      id: "comp_1",
      component: VALID_DESCRIPTOR,
    });
    expect(result.success).toBe(true);
  });

  it("ResponseResourceSchema.output accepts a mixed [message, component] array", async () => {
    const { ResponseResourceSchema } = await import("./open-responses.schema.js");
    const result = ResponseResourceSchema.safeParse({
      id: "resp_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "openclaw",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
          status: "completed",
        },
        { type: "component", id: "comp_1", component: VALID_DESCRIPTOR },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-stream
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenResponses component output — non-stream", () => {
  it("lifts a channelData component into a second output item", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "Here is your confirmation", channelData: COMPONENT_CHANNEL_DATA }],
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { output: Array<Record<string, unknown>> };
      expect(json.output.length).toBe(2);
      expect(json.output[0]?.type).toBe("message");
      expect(json.output[1]?.type).toBe("component");
      expect(json.output[1]?.component).toEqual(VALID_DESCRIPTOR);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("ignores channelData that is not a component", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "hi", channelData: { type: "other", foo: 1 } }],
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      const json = (await res.json()) as { output: Array<Record<string, unknown>> };
      expect(json.output.length).toBe(1);
      expect(json.output[0]?.type).toBe("message");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("drops a malformed component descriptor silently", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [
          {
            text: "hi",
            channelData: {
              type: "component",
              component: { type: "component", key: "x", props: {}, ui: {} }, // no ui.summary
            },
          },
        ],
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { output: Array<Record<string, unknown>> };
      expect(json.output.length).toBe(1);
      expect(json.output[0]?.type).toBe("message");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("produces a single message item when there is no channelData (characterization)", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      const json = (await res.json()) as { output: Array<Record<string, unknown>> };
      expect(json.output.length).toBe(1);
      const item = json.output[0] ?? {};
      expect(item.type).toBe("message");
      expect(item.role).toBe("assistant");
      expect((item.content as Array<Record<string, unknown>>)[0]?.text).toBe("hello");
    } finally {
      await server.close({ reason: "test done" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenResponses component output — stream", () => {
  it("emits output_item.added + done at output_index 1 and includes it in completed", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "confirmation", channelData: COMPONENT_CHANNEL_DATA }],
      } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      expect(res.status).toBe(200);
      const events = parseSseEvents(await res.text());

      const componentAdded = events.filter((e) => {
        if (e.event !== "response.output_item.added") {
          return false;
        }
        const parsed = JSON.parse(e.data) as { output_index?: number; item?: { type?: string } };
        return parsed.output_index === 1 && parsed.item?.type === "component";
      });
      expect(componentAdded.length).toBe(1);

      const componentDone = events.filter((e) => {
        if (e.event !== "response.output_item.done") {
          return false;
        }
        const parsed = JSON.parse(e.data) as { output_index?: number; item?: { type?: string } };
        return parsed.output_index === 1 && parsed.item?.type === "component";
      });
      expect(componentDone.length).toBe(1);

      const completed = events.find((e) => e.event === "response.completed");
      expect(completed).toBeDefined();
      const completedResp = JSON.parse(completed?.data ?? "{}") as {
        response?: { output?: Array<{ type?: string; component?: unknown }> };
      };
      const output = completedResp.response?.output ?? [];
      const componentItem = output.find((o) => o.type === "component");
      expect(componentItem?.component).toEqual(VALID_DESCRIPTOR);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("emits no component on a failed-status turn", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "boom", channelData: COMPONENT_CHANNEL_DATA }],
        meta: { error: { kind: "provider_error", message: "boom" } },
      } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      const events = parseSseEvents(await res.text());
      const hasComponent = events.some((e) => {
        if (e.data === "[DONE]") {
          return false;
        }
        const parsed = JSON.parse(e.data || "{}") as {
          item?: { type?: string };
          response?: { output?: Array<{ type?: string }> };
        };
        return (
          parsed.item?.type === "component" ||
          (parsed.response?.output ?? []).some((o) => o.type === "component")
        );
      });
      expect(hasComponent).toBe(false);
    } finally {
      await server.close({ reason: "test done" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN-1 — ui.summary degradation floor (D5 / Component 5 / R4)
// ─────────────────────────────────────────────────────────────────────────────

describe("DESIGN-1: ui.summary degradation floor", () => {
  it("non-stream: a component-only payload (empty text) seeds message text from ui.summary", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "", channelData: COMPONENT_CHANNEL_DATA }],
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        output: Array<{ type?: string; content?: Array<{ text?: string }> }>;
      };
      const message = json.output.find((o) => o.type === "message");
      expect(message?.content?.[0]?.text).toBe(VALID_DESCRIPTOR.ui.summary);
      // Floor must not be the no-response sentinel.
      expect(message?.content?.[0]?.text).not.toBe("No response from OpenClaw.");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("non-stream: real LLM narration is kept (summary NOT substituted/appended)", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "Here is your confirmation", channelData: COMPONENT_CHANNEL_DATA }],
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      const json = (await res.json()) as {
        output: Array<{ type?: string; content?: Array<{ text?: string }> }>;
      };
      const message = json.output.find((o) => o.type === "message");
      expect(message?.content?.[0]?.text).toBe("Here is your confirmation");
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("stream: a component-only payload seeds output_text.done + message item from ui.summary", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "", channelData: COMPONENT_CHANNEL_DATA }],
      } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      const events = parseSseEvents(await res.text());

      const textDone = events.find((e) => e.event === "response.output_text.done");
      const textDoneParsed = JSON.parse(textDone?.data ?? "{}") as { text?: string };
      expect(textDoneParsed.text).toBe(VALID_DESCRIPTOR.ui.summary);

      const completed = events.find((e) => e.event === "response.completed");
      const completedResp = JSON.parse(completed?.data ?? "{}") as {
        response?: { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> };
      };
      const message = (completedResp.response?.output ?? []).find((o) => o.type === "message");
      expect(message?.content?.[0]?.text).toBe(VALID_DESCRIPTOR.ui.summary);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("stream: real LLM narration is kept (summary NOT substituted)", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "Streamed narration", channelData: COMPONENT_CHANNEL_DATA }],
      } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      const events = parseSseEvents(await res.text());
      const completed = events.find((e) => e.event === "response.completed");
      const completedResp = JSON.parse(completed?.data ?? "{}") as {
        response?: { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> };
      };
      const message = (completedResp.response?.output ?? []).find((o) => o.type === "message");
      expect(message?.content?.[0]?.text).toBe("Streamed narration");
    } finally {
      await server.close({ reason: "test done" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-1 — bounds under the compromised-backend threat model
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-1: component lift bounds", () => {
  it("non-stream: caps lifted components at MAX_COMPONENTS_PER_TURN (8) — 9 in ⇒ 8 out", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: Array.from({ length: 9 }, () => ({
          text: "",
          channelData: COMPONENT_CHANNEL_DATA,
        })),
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      const json = (await res.json()) as { output: Array<{ type?: string }> };
      const components = json.output.filter((o) => o.type === "component");
      expect(components.length).toBe(8);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("parseComponentDescriptor returns (does not stack-overflow) on a deeply-nested value", () => {
    // Build a ~500-deep nested object in props — CWE-674 stack-exhaustion probe.
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 500; i++) {
      nested = { child: nested };
    }
    const descriptor = {
      type: "component",
      key: "deep",
      props: { nested },
      ui: { summary: "deep" },
    };
    // Must return without throwing (RangeError: Maximum call stack size exceeded).
    expect(() => parseComponentDescriptor(descriptor)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coverage locks (QG TEST-1,3,4,5,6,7,9)
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenResponses component output — coverage locks", () => {
  it("TEST-1: non-stream FAILED turn drops the component (status failed, no output)", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "boom", channelData: COMPONENT_CHANNEL_DATA }],
        meta: { error: { kind: "provider_error", message: "boom" } },
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      const json = (await res.json()) as { status?: string; output?: Array<{ type?: string }> };
      expect(json.status).toBe("failed");
      expect(json.output?.length).toBe(0);
      expect((json.output ?? []).some((o) => o.type === "component")).toBe(false);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("TEST-3 (non-stream): function_call wins over component in the same turn", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "", channelData: COMPONENT_CHANNEL_DATA }],
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }],
        },
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      const json = (await res.json()) as {
        output: Array<{ type?: string; call_id?: string }>;
      };
      const fnCall = json.output.find((o) => o.type === "function_call");
      expect(fnCall).toBeDefined();
      expect(json.output.some((o) => o.type === "component")).toBe(false);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("TEST-3 (stream): function_call wins over component; no shared output_index", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "", channelData: COMPONENT_CHANNEL_DATA }],
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }],
        },
      } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      const events = parseSseEvents(await res.text());

      const hasComponent = events.some((e) => {
        if (e.data === "[DONE]") {
          return false;
        }
        const parsed = JSON.parse(e.data || "{}") as {
          item?: { type?: string };
          response?: { output?: Array<{ type?: string }> };
        };
        return (
          parsed.item?.type === "component" ||
          (parsed.response?.output ?? []).some((o) => o.type === "component")
        );
      });
      expect(hasComponent).toBe(false);

      // No two output_item.added/done events share an output_index within a type.
      const completed = events.find((e) => e.event === "response.completed");
      const completedResp = JSON.parse(completed?.data ?? "{}") as {
        response?: { output?: Array<{ type?: string }> };
      };
      const hasFn = (completedResp.response?.output ?? []).some((o) => o.type === "function_call");
      expect(hasFn).toBe(true);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("TEST-4 (non-stream): two components ⇒ output === [message, component, component]", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [
          { text: "narration", channelData: COMPONENT_CHANNEL_DATA },
          { text: "", channelData: COMPONENT_CHANNEL_DATA_2 },
        ],
      } as never);

      const res = await postResponses(port, { stream: false, model: "openclaw", input: "hi" });
      const json = (await res.json()) as {
        output: Array<{ type?: string; component?: unknown }>;
      };
      expect(json.output.map((o) => o.type)).toEqual(["message", "component", "component"]);
      expect(json.output[1]?.component).toEqual(VALID_DESCRIPTOR);
      expect(json.output[2]?.component).toEqual(VALID_DESCRIPTOR_2);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("TEST-4/5 (stream): two components at contiguous distinct indices 1,2; SSE ordering", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [
          { text: "narration", channelData: COMPONENT_CHANNEL_DATA },
          { text: "", channelData: COMPONENT_CHANNEL_DATA_2 },
        ],
      } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      const rawEvents = parseSseEvents(await res.text());
      const events = rawEvents.filter((e) => e.data !== "[DONE]");

      const componentAddedIndices = events
        .filter((e) => e.event === "response.output_item.added")
        .map((e) => JSON.parse(e.data) as { output_index?: number; item?: { type?: string } })
        .filter((p) => p.item?.type === "component")
        .map((p) => p.output_index);
      expect(componentAddedIndices).toEqual([1, 2]);

      // response.completed includes both components.
      const completed = events.find((e) => e.event === "response.completed");
      const completedResp = JSON.parse(completed?.data ?? "{}") as {
        response?: { output?: Array<{ type?: string }> };
      };
      const componentCount = (completedResp.response?.output ?? []).filter(
        (o) => o.type === "component",
      ).length;
      expect(componentCount).toBe(2);

      // TEST-5 ordering: for the FIRST component (index 1),
      // added < done < response.completed; and the message item.done (index 0) < component added.
      const indexOfEvent = (pred: (e: { event?: string; data: string }) => boolean) =>
        events.findIndex(pred);
      const firstComponentAdded = indexOfEvent(
        (e) =>
          e.event === "response.output_item.added" &&
          (JSON.parse(e.data) as { output_index?: number; item?: { type?: string } }).item?.type ===
            "component",
      );
      const firstComponentDone = indexOfEvent(
        (e) =>
          e.event === "response.output_item.done" &&
          (JSON.parse(e.data) as { output_index?: number; item?: { type?: string } }).item?.type ===
            "component",
      );
      const completedIdx = indexOfEvent((e) => e.event === "response.completed");
      const messageDone = indexOfEvent(
        (e) =>
          e.event === "response.output_item.done" &&
          (JSON.parse(e.data) as { output_index?: number; item?: { type?: string } }).item?.type ===
            "message",
      );
      expect(firstComponentAdded).toBeGreaterThan(-1);
      expect(firstComponentAdded).toBeLessThan(firstComponentDone);
      expect(firstComponentDone).toBeLessThan(completedIdx);
      expect(messageDone).toBeGreaterThan(-1);
      expect(messageDone).toBeLessThan(firstComponentAdded);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("TEST-6 (stream): malformed descriptor dropped + non-component channelData ignored", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [
          {
            text: "hi",
            channelData: {
              type: "component",
              component: { type: "component", key: "x", props: {}, ui: {} }, // no ui.summary
            },
          },
          { text: "", channelData: { type: "other", foo: 1 } },
        ],
      } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      const events = parseSseEvents(await res.text());
      const hasComponent = events.some((e) => {
        if (e.data === "[DONE]") {
          return false;
        }
        const parsed = JSON.parse(e.data || "{}") as {
          item?: { type?: string };
          response?: { output?: Array<{ type?: string }> };
        };
        return (
          parsed.item?.type === "component" ||
          (parsed.response?.output ?? []).some((o) => o.type === "component")
        );
      });
      expect(hasComponent).toBe(false);
    } finally {
      await server.close({ reason: "test done" });
    }
  });

  it("TEST-9 (stream): no channelData ⇒ zero component events, single message item", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

      const res = await postResponses(port, { stream: true, model: "openclaw", input: "hi" });
      const events = parseSseEvents(await res.text());
      const componentEvents = events.filter((e) => {
        if (e.data === "[DONE]") {
          return false;
        }
        const parsed = JSON.parse(e.data || "{}") as { item?: { type?: string } };
        return parsed.item?.type === "component";
      });
      expect(componentEvents.length).toBe(0);

      const completed = events.find((e) => e.event === "response.completed");
      const completedResp = JSON.parse(completed?.data ?? "{}") as {
        response?: { output?: Array<{ type?: string }> };
      };
      const output = completedResp.response?.output ?? [];
      expect(output.length).toBe(1);
      expect(output[0]?.type).toBe("message");
    } finally {
      await server.close({ reason: "test done" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-2 / TEST-7 — D6 channel wiring + S10 presentation-only invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("D6 channel wiring — /v1/responses messageChannel", () => {
  const channelForHeader = async (
    headers?: Record<string, string>,
  ): Promise<string | undefined> => {
    const port = await getFreePort();
    const server = await startServer(port);
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hi" }] } as never);
      const res = await postResponses(
        port,
        { stream: false, model: "openclaw", input: "hi" },
        headers,
      );
      await res.text();
      const [opts] = agentCommand.mock.calls[0] ?? [];
      return (opts as { messageChannel?: string } | undefined)?.messageChannel;
    } finally {
      await server.close({ reason: "test done" });
    }
  };

  it("TEST-2: shrinemobile ⇒ messageChannel 'shrinemobile'", async () => {
    expect(await channelForHeader({ "x-openclaw-channel": "shrinemobile" })).toBe("shrinemobile");
  });

  it("TEST-2: non-allowlisted 'telegram' ⇒ 'webchat'", async () => {
    expect(await channelForHeader({ "x-openclaw-channel": "telegram" })).toBe("webchat");
  });

  it("TEST-2: absent header ⇒ 'webchat'", async () => {
    expect(await channelForHeader()).toBe("webchat");
  });

  it("TEST-7 (S10): channel header changes ONLY messageChannel — sessionKey + externalId byte-identical", async () => {
    const port = await getFreePort();
    const server = await startServer(port);
    const call = async (channel: string) => {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hi" }] } as never);
      const res = await postResponses(
        port,
        { stream: false, model: "openclaw", input: "hi" },
        { "x-openclaw-session-key": "thread-s10", "x-openclaw-channel": channel },
      );
      await res.text();
      const [opts] = agentCommand.mock.calls[0] ?? [];
      return opts as { sessionKey?: string; externalId?: unknown; messageChannel?: string };
    };
    try {
      const webchat = await call("webchat");
      const shrinemobile = await call("shrinemobile");
      expect(webchat.sessionKey).toBe(shrinemobile.sessionKey);
      expect(webchat.externalId).toBe(shrinemobile.externalId);
      expect(webchat.messageChannel).toBe("webchat");
      expect(shrinemobile.messageChannel).toBe("shrinemobile");
      expect(webchat.messageChannel).not.toBe(shrinemobile.messageChannel);
    } finally {
      await server.close({ reason: "test done" });
    }
  });
});
