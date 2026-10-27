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
import { truncateOversizedToolResultsInSession } from "./pi-embedded-runner/tool-result-truncation.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];
const asAppendMessage = (message: unknown) => message as AppendMessage;

// 3000 deterministic bytes -> "2.9 KB" in the placeholder.
const IMAGE_BYTES = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
const IMAGE_B64 = IMAGE_BYTES.toString("base64");
const IMAGE_SHA12 = crypto.createHash("sha256").update(IMAGE_BYTES).digest("hex").slice(0, 12);
const EXPECTED_PLACEHOLDER = `[image: image/jpeg, 2.9 KB, sha256:${IMAGE_SHA12}]`;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ASSISTANT = {
  role: "assistant",
  content: [{ type: "text", text: "looks like oatmeal" }],
  stopReason: "stop",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  timestamp: 2,
};

/** A file-backed session (SessionManager only writes once an assistant message exists). */
function diskSession(): SessionManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-image-placeholder-"));
  tmpDirs.push(dir);
  return SessionManager.create(dir, dir);
}

function diskMessages(sm: SessionManager): AgentMessage[] {
  const raw = fs.readFileSync(sm.getSessionFile() as string, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { type: string; message?: AgentMessage })
    .filter((e) => e.type === "message")
    .map((e) => e.message as AgentMessage);
}

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

describe("installSessionToolResultGuard image persistence", () => {
  it("persists a user image as one placeholder with mime, size and hash prefix", () => {
    const sm = diskSession();
    installSessionToolResultGuard(sm);

    sm.appendMessage(asAppendMessage(userImageMessage()));
    sm.appendMessage(asAppendMessage(ASSISTANT));

    const [persisted] = diskMessages(sm);
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
    const sm = diskSession();
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

    const persisted = diskMessages(sm).find((m) => m.role === "toolResult");
    const blocks = contentBlocks(persisted);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
    expect(blocks).toContainEqual({ type: "text", text: EXPECTED_PLACEHOLDER });
    expect(toolResult.content[1]?.type).toBe("image");
  });

  it("keeps the image in the in-memory entries that compaction rebuilds context from", () => {
    const sm = diskSession();
    installSessionToolResultGuard(sm);
    sm.appendMessage(asAppendMessage(userImageMessage()));
    sm.appendMessage(asAppendMessage(ASSISTANT));

    // Disk: placeholder only.
    const raw = fs.readFileSync(sm.getSessionFile() as string, "utf8");
    expect(raw).not.toContain(IMAGE_B64);
    expect(raw).toContain(EXPECTED_PLACEHOLDER);

    // Memory: the entry and the context rebuilt from it keep the image.
    const imageBlock = { type: "image", data: IMAGE_B64, mimeType: "image/jpeg" };
    expect(contentBlocks(persistedMessages(sm)[0])).toContainEqual(imageBlock);
    const firstKept = sm.getEntries().find((e) => e.type === "message")?.id as string;
    // The rebuild agent-session runs after a (manual or auto) compaction.
    sm.appendCompaction("summary", firstKept, 100);
    const rebuilt = sm.buildSessionContext().messages;
    const user = rebuilt.find((m) => m.role === "user");
    expect(contentBlocks(user)).toContainEqual(imageBlock);
    // The compaction write still put no base64 on disk.
    expect(fs.readFileSync(sm.getSessionFile() as string, "utf8")).not.toContain(IMAGE_B64);
  });

  it("re-appends via tool-result truncation without writing base64 to disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-image-truncation-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "s.jsonl");
    // A legacy transcript: an oversized tool result followed by a user image in base64.
    const lines = [
      { type: "session", version: 3, id: "s1", timestamp: "t", cwd: dir },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "t",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "t",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(200_000) }],
          isError: false,
          timestamp: 1,
        },
      },
      { type: "message", id: "u1", parentId: "t1", timestamp: "t", message: userImageMessage() },
      { type: "message", id: "a2", parentId: "u1", timestamp: "t", message: ASSISTANT },
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const count = (text: string) => text.split(IMAGE_B64).length - 1;
    expect(count(fs.readFileSync(file, "utf8"))).toBe(1);

    const result = await truncateOversizedToolResultsInSession({
      sessionFile: file,
      contextWindowTokens: 8_000,
    });

    expect(result.truncated).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    // The re-appended copy of the user message is a placeholder; base64 does not grow.
    expect(count(after)).toBe(1);
    expect(after).toContain(EXPECTED_PLACEHOLDER);
  });

  it("history re-scan after conversion: the text path is re-detected, the placeholder is not", async () => {
    const sm = diskSession();
    installSessionToolResultGuard(sm);
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: [
          { type: "text", text: "see /tmp/x/photo.png" },
          { type: "image", data: IMAGE_B64, mimeType: "image/jpeg" },
        ],
        timestamp: 1,
      }),
    );
    sm.appendMessage(asAppendMessage(ASSISTANT));
    const reopened = SessionManager.open(sm.getSessionFile() as string);
    const result = await detectAndLoadPromptImages({
      prompt: "and now?",
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "image"] },
      historyMessages: reopened.buildSessionContext().messages,
    });
    // Before conversion the message carried an image block, so history scanning skipped it.
    // After conversion it carries only text, so the literal path in the user's text is
    // detected again (exactly one ref). The file does not exist here, so nothing is loaded;
    // the placeholder itself never counts as a ref.
    expect(result.detectedRefs).toHaveLength(1);
    expect(result.detectedRefs[0]?.resolved).toBe("/tmp/x/photo.png");
    expect(result.historyImagesByIndex.size).toBe(0);
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
