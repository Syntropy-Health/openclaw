/**
 * OpenResponses `component` output item (T3.1)
 *
 * A ComponentDescriptor riding in a reply payload's `channelData`
 * (wire shape `{ type: "component", component: <descriptor> }`) is lifted to a
 * fourth `component` output item on POST /v1/responses — additive to the
 * assistant message, on both the non-stream and streaming paths.
 */

import { describe, expect, it } from "vitest";
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

async function startServer(port: number) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openResponsesEnabled: true,
  } as const);
}

async function postResponses(port: number, body: unknown) {
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
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
