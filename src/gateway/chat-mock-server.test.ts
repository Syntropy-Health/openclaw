// Tests for the standalone chat MOCK server (scripts/dev/chat-mock-server.ts).
//
// These boot the mock on an ephemeral port and assert the contract-faithful
// behavior shrinemobile debugs against:
//   - 401 on no/bad/expired token (REAL verifyClerkJwt, fail-closed)
//   - the FULL §2.2 SSE named-event sequence, in order, on a valid JWT (stream:true)
//   - the §2.3 envelope on stream:false
//   - 429 + Retry-After after the --budget is exhausted
//   - scope/session threading echoed into the mock reply
//
// The server has NO channels / NO startGatewayServer, so this is safe to run
// alongside the live bot.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startChatMockServer } from "../../scripts/dev/chat-mock-server.js";

type Started = Awaited<ReturnType<typeof startChatMockServer>>;

let srv: Started;

afterEach(async () => {
  await srv?.close();
});

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

async function post(srv: Started, body: unknown, headers?: Record<string, string>) {
  return fetch(`${srv.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("chat-mock-server auth (REAL verifyClerkJwt, fail-closed)", () => {
  beforeEach(async () => {
    srv = await startChatMockServer({ streamDelayMs: 0 });
  });

  it("401 with no Authorization header", async () => {
    const res = await post(srv, { model: "openclaw", input: "hi" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("unauthorized");
  });

  it("401 with a malformed bearer token", async () => {
    const res = await post(
      srv,
      { model: "openclaw", input: "hi" },
      { authorization: "Bearer not.a.jwt" },
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("unauthorized");
  });

  it("200 with a valid locally-minted Clerk JWT", async () => {
    const jwt = srv.mintBearer("user_test");
    const res = await post(
      srv,
      { model: "openclaw", input: "hi", stream: false },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(200);
    await res.json();
  });
});

describe("chat-mock-server streaming (§2.2 named-event sequence)", () => {
  beforeEach(async () => {
    srv = await startChatMockServer({ streamDelayMs: 0 });
  });

  it("emits the exact ordered SSE sequence on a valid JWT", async () => {
    const jwt = srv.mintBearer("user_stream");
    const res = await post(
      srv,
      { model: "openclaw", input: "hello from mobile", stream: true },
      { authorization: `Bearer ${jwt}`, "x-openclaw-session-key": "thread-1" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const events = parseSseEvents(text);
    const names = events.map((e) => e.event).filter((e): e is string => e !== undefined);

    // Fixed framing events, in order.
    expect(names[0]).toBe("response.created");
    expect(names[1]).toBe("response.in_progress");
    expect(names[2]).toBe("response.output_item.added");
    expect(names[3]).toBe("response.content_part.added");

    // One-or-more deltas.
    const firstDelta = names.indexOf("response.output_text.delta");
    expect(firstDelta).toBe(4);
    const deltaCount = names.filter((n) => n === "response.output_text.delta").length;
    expect(deltaCount).toBeGreaterThanOrEqual(4);
    expect(deltaCount).toBeLessThanOrEqual(8);

    // Tail framing, in order, AFTER the last delta.
    const tail = names.slice(firstDelta + deltaCount);
    expect(tail).toEqual([
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    // Terminator.
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // delta `data:` is the FULL event object (zero wire drift vs real handler).
    const deltaEvt = JSON.parse(events[firstDelta].data) as {
      type: string;
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    };
    expect(deltaEvt.type).toBe("response.output_text.delta");
    expect(typeof deltaEvt.item_id).toBe("string");
    expect(deltaEvt.output_index).toBe(0);
    expect(deltaEvt.content_index).toBe(0);
    expect(typeof deltaEvt.delta).toBe("string");

    // response.completed carries the full ResponseResource incl. usage.
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed).toBeDefined();
    const completedResource = JSON.parse(completed!.data).response as {
      object: string;
      status: string;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      output: Array<{ type: string; content: Array<{ text: string }> }>;
    };
    expect(completedResource.object).toBe("response");
    expect(completedResource.status).toBe("completed");
    expect(completedResource.usage.total_tokens).toBeGreaterThan(0);

    // Reassembled text == the deterministic echo with scope + session threaded.
    const reassembled = events
      .filter((e) => e.event === "response.output_text.delta")
      .map((e) => (JSON.parse(e.data) as { delta: string }).delta)
      .join("");
    expect(reassembled).toBe(completedResource.output[0].content[0].text);
    expect(reassembled).toContain("[mock] you said: hello from mobile");
    expect(reassembled).toContain("scope=user_stream");
    expect(reassembled).toContain("session=thread-1");
  });
});

describe("chat-mock-server non-streaming (§2.3 envelope)", () => {
  beforeEach(async () => {
    srv = await startChatMockServer({ streamDelayMs: 0 });
  });

  it("returns the §2.3 JSON envelope on stream:false", async () => {
    const jwt = srv.mintBearer("user_ns");
    const res = await post(
      srv,
      { model: "openclaw", input: "hello", stream: false },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      id: string;
      object: string;
      created_at: number;
      status: string;
      model: string;
      output: Array<{
        type: string;
        id: string;
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      error: unknown;
    };
    expect(body.id).toMatch(/^resp_/);
    expect(body.object).toBe("response");
    expect(typeof body.created_at).toBe("number");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("openclaw");
    expect(body.error).toBeNull();
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].role).toBe("assistant");
    expect(body.output[0].content[0].type).toBe("output_text");
    expect(body.output[0].content[0].text).toContain("[mock] you said: hello");
    expect(body.usage.total_tokens).toBe(body.usage.input_tokens + body.usage.output_tokens);
  });

  it("400 when `input` is missing", async () => {
    const jwt = srv.mintBearer("user_400");
    const res = await post(
      srv,
      { model: "openclaw", stream: false },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("invalid_request_error");
  });
});

describe("chat-mock-server τ budget (429 + Retry-After)", () => {
  beforeEach(async () => {
    srv = await startChatMockServer({ streamDelayMs: 0, budget: 2 });
  });

  it("returns 429 + Retry-After after the budget is exhausted, per sub", async () => {
    const jwt = srv.mintBearer("user_budget");
    const headers = { authorization: `Bearer ${jwt}` };
    const turn = () => post(srv, { model: "openclaw", input: "hi", stream: false }, headers);

    expect((await turn()).status).toBe(200); // 1
    expect((await turn()).status).toBe(200); // 2
    const third = await turn(); // 3 → over budget
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
    const json = (await third.json()) as { error: { type: string } };
    expect(json.error.type).toBe("rate_limited");

    // A different sub has its own budget.
    const other = srv.mintBearer("user_other");
    const otherRes = await post(
      srv,
      { model: "openclaw", input: "hi", stream: false },
      { authorization: `Bearer ${other}` },
    );
    expect(otherRes.status).toBe(200);
  });
});
