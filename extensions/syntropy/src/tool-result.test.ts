import { describe, expect, it } from "vitest";
import { toAgentResult } from "./tool-result.js";

// The one mapping from an MCP tool result to the agent-loop result shape, shared
// by the syntropy tools, the KG tools and syntropy-mcp's dynamic tools.
describe("toAgentResult", () => {
  it("passes string data through as the text", () => {
    expect(toAgentResult({ ok: true, data: "hello" })).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: "hello",
    });
  });

  it("renders object data as indented JSON and keeps it as details", () => {
    const data = { a: 1, b: ["x"] };
    expect(toAgentResult({ ok: true, data })).toEqual({
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      details: data,
    });
  });

  it("reports an error with its message", () => {
    expect(toAgentResult({ ok: false, data: null, error: "boom" })).toEqual({
      content: [{ type: "text", text: "Error: boom" }],
      details: { error: "boom" },
    });
  });

  it("reports an error without a message as unknown", () => {
    expect(toAgentResult({ ok: false, data: null })).toEqual({
      content: [{ type: "text", text: "Error: Unknown error" }],
      details: { error: undefined },
    });
  });
});
