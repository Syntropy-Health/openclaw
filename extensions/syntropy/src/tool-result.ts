import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { McpToolResult } from "./client.js";

/** Map an {@link McpToolResult} to the agent-loop result shape. */
export function toAgentResult(res: McpToolResult): AgentToolResult<unknown> {
  if (!res.ok) {
    return {
      content: [{ type: "text", text: `Error: ${res.error ?? "Unknown error"}` }],
      details: { error: res.error },
    };
  }
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
  return { content: [{ type: "text", text }], details: res.data };
}
