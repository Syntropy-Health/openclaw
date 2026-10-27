import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeSessionMessagesImages } from "./pi-embedded-helpers/images.js";
import { validateAnthropicTurns } from "./pi-embedded-helpers/turns.js";
import { detectAndLoadPromptImages } from "./pi-embedded-runner/run/images.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];
const asAppendMessage = (message: unknown) => message as AppendMessage;

// 3000 deterministic bytes -> "2.9 KB" in the placeholder.
const IMAGE_BYTES = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
const IMAGE_B64 = IMAGE_BYTES.toString("base64");
const IMAGE_SHA12 = crypto.createHash("sha256").update(IMAGE_BYTES).digest("hex").slice(0, 12);
const EXPECTED_PLACEHOLDER = `[image: image/jpeg, 2.9 KB, sha256:${IMAGE_SHA12}]`;

function persistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

function contentBlocks(message: AgentMessage | undefined): Array<Record<string, unknown>> {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function userImageMessage() {
  return {
    role: "user",
    content: [
      { type: "text", text: "what did I eat?" },
      { type: "image", data: IMAGE_B64, mimeType: "image/jpeg" },
    ],
    timestamp: 1,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("installSessionToolResultGuard image persistence", () => {
  it("persists a user image as one placeholder with mime, size and hash prefix", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(asAppendMessage(userImageMessage()));

    const [persisted] = persistedMessages(sm);
    const blocks = contentBlocks(persisted);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
    expect(JSON.stringify(persisted)).not.toContain(IMAGE_B64);
    const placeholders = blocks.filter(
      (b) => b.type === "text" && String(b.text).startsWith("[image:"),
    );
    expect(placeholders).toEqual([{ type: "text", text: EXPECTED_PLACEHOLDER }]);
    expect(blocks[0]).toEqual({ type: "text", text: "what did I eat?" });
  });

  it("never mutates the in-memory message handed to the model", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);
    const message = userImageMessage();
    const before = structuredClone(message);

    sm.appendMessage(asAppendMessage(message));

    expect(message).toEqual(before);
    expect(message.content[1]).toEqual({ type: "image", data: IMAGE_B64, mimeType: "image/jpeg" });
  });

  it("persists text-only messages byte-identically", () => {
    const guarded = SessionManager.inMemory();
    installSessionToolResultGuard(guarded);
    const plain = SessionManager.inMemory();
    const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
    const userString = { role: "user", content: "plain string", timestamp: 2 };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stopReason: "stop",
      timestamp: 3,
    };

    for (const sm of [guarded, plain]) {
      sm.appendMessage(asAppendMessage(user));
      sm.appendMessage(asAppendMessage(userString));
      sm.appendMessage(asAppendMessage(assistant));
    }

    expect(JSON.stringify(persistedMessages(guarded))).toBe(
      JSON.stringify(persistedMessages(plain)),
    );
    // Untouched messages are persisted as-is, not as a copy.
    expect(persistedMessages(guarded)[0]).toBe(user);
  });

  it("converts toolResult images (screenshots) to placeholders too", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "browser", arguments: {} }],
      }),
    );
    const toolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "browser",
      content: [
        { type: "text", text: "screenshot" },
        { type: "image", data: IMAGE_B64, mimeType: "image/jpeg" },
      ],
      isError: false,
      timestamp: 2,
    };

    sm.appendMessage(asAppendMessage(toolResult));

    const persisted = persistedMessages(sm).find((m) => m.role === "toolResult");
    const blocks = contentBlocks(persisted);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
    expect(blocks).toContainEqual({ type: "text", text: EXPECTED_PLACEHOLDER });
    expect(toolResult.content[1]?.type).toBe("image");
  });

  it("reloads a placeholder session from disk without crashing the history pipeline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-image-placeholder-"));
    tmpDirs.push(dir);
    const sm = SessionManager.create(dir, dir);
    installSessionToolResultGuard(sm);
    sm.appendMessage(asAppendMessage(userImageMessage()));
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "looks like oatmeal" }],
        stopReason: "stop",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        timestamp: 2,
      }),
    );
    const sessionFile = sm.getSessionFile();
    expect(sessionFile).toBeTruthy();
    const raw = fs.readFileSync(sessionFile as string, "utf8");
    expect(raw).not.toContain(IMAGE_B64);
    expect(raw).toContain(EXPECTED_PLACEHOLDER);

    const reopened = SessionManager.open(sessionFile as string, dir);
    const history = reopened.buildSessionContext().messages;
    expect(contentBlocks(history[0])).toContainEqual({ type: "text", text: EXPECTED_PLACEHOLDER });

    const sanitized = await sanitizeSessionMessagesImages(history, "reload");
    const validated = validateAnthropicTurns(sanitized);
    const images = await detectAndLoadPromptImages({
      prompt: "and how many calories?",
      workspaceDir: dir,
      model: { input: ["text", "image"] },
      historyMessages: validated,
    });
    expect(validated).toHaveLength(2);
    expect(images.historyImagesByIndex.size).toBe(0);
    expect(images.detectedRefs).toHaveLength(0);
  });
});
