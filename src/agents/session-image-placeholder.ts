import crypto from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Session transcripts never store base64 image bytes. Each image block is replaced
 * with a text placeholder that keeps enough to identify it:
 *
 *   [image: <mimeType>, <KB> KB, sha256:<first 12 hex of sha256(decoded bytes)>]
 *
 * scripts/maintenance/scrub-transcript-images.mjs emits the same format; keep them in step.
 */

type ImageLike = { mimeType: string; base64: string };

function stripDataUrlPrefix(data: string): string {
  const match = /^data:[^;,]*;base64,/i.exec(data);
  return match ? data.slice(match[0].length) : data;
}

/** Recognises the image block shapes the agent libraries emit. */
function readImageBlock(block: unknown): ImageLike | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const rec = block as Record<string, unknown>;
  if (rec.type !== "image") {
    return null;
  }
  // pi-ai ImageContent: { type: "image", data, mimeType }
  if (typeof rec.data === "string") {
    return {
      mimeType: typeof rec.mimeType === "string" ? rec.mimeType : "application/octet-stream",
      base64: stripDataUrlPrefix(rec.data),
    };
  }
  // Anthropic-style: { type: "image", source: { type: "base64", media_type, data } }
  const source = rec.source as Record<string, unknown> | undefined;
  if (source && source.type === "base64" && typeof source.data === "string") {
    return {
      mimeType:
        typeof source.media_type === "string" ? source.media_type : "application/octet-stream",
      base64: stripDataUrlPrefix(source.data),
    };
  }
  return null;
}

export function formatImagePlaceholder(mimeType: string, bytes: Buffer): string {
  const kb = (bytes.byteLength / 1024).toFixed(1);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return `[image: ${mimeType}, ${kb} KB, sha256:${sha}]`;
}

/**
 * Returns a copy of `message` whose image blocks are replaced by text placeholders,
 * or the original object when it carries no image blocks. Never mutates its input.
 */
export function replaceImageBlocksForPersistence(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return message;
  }
  let changed = false;
  const next = content.map((block: unknown) => {
    const image = readImageBlock(block);
    if (!image) {
      return block;
    }
    changed = true;
    const bytes = Buffer.from(image.base64, "base64");
    return { type: "text", text: formatImagePlaceholder(image.mimeType, bytes) };
  });
  return changed ? ({ ...message, content: next } as AgentMessage) : message;
}
