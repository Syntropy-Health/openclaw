/**
 * Message extraction shared by capture (agent_end) and forget (tombstones over
 * transcript entries), so both hash exactly the same text.
 */

// ============================================================================
// Message extraction from unknown[]
// ============================================================================

export type ExtractedMessage = {
  content: string;
  roleType: "user" | "assistant";
};

export function extractMessages(messages: unknown[]): ExtractedMessage[] {
  const result: ExtractedMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    const role = msgObj.role;

    // Only capture user and assistant messages (skip tool results)
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = msgObj.content;
    let text = "";

    // Handle string content directly
    if (typeof content === "string") {
      text = content;
    }

    // Handle array content (content blocks)
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          parts.push((block as Record<string, unknown>).text as string);
        }
      }
      text = parts.join("\n");
    }

    if (text.trim()) {
      result.push({
        content: text,
        roleType: role as "user" | "assistant",
      });
    }
  }

  return result;
}
