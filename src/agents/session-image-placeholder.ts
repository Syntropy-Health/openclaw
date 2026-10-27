import crypto from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

/**
 * Session transcripts never store base64 image bytes. Each image block is replaced
 * with a text placeholder that keeps enough to identify it:
 *
 *   [image: <mimeType>, <KB> KB, sha256:<first 12 hex of sha256(decoded bytes)>]
 *
 * scripts/maintenance/scrub-transcript-images.mjs emits the same format; keep them in step.
 */

type ImageLike = { mimeType: string; base64: string };

/** Splits `data:<mime>[;param=value]*;base64,<payload>`; plain base64 passes through. */
function parseDataUrl(data: string): { mimeType?: string; base64: string } {
  const match = /^data:([^;,]*)((?:;[^;,]*)*);base64,/i.exec(data);
  if (!match) {
    return { base64: data };
  }
  return { mimeType: match[1] || undefined, base64: data.slice(match[0].length) };
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
  let declared: string | undefined;
  let data: string;
  const source = rec.source as Record<string, unknown> | undefined;
  if (typeof rec.data === "string") {
    // pi-ai ImageContent: { type: "image", data, mimeType }
    declared = typeof rec.mimeType === "string" ? rec.mimeType : undefined;
    data = rec.data;
  } else if (source && source.type === "base64" && typeof source.data === "string") {
    // Anthropic-style: { type: "image", source: { type: "base64", media_type, data } }
    declared = typeof source.media_type === "string" ? source.media_type : undefined;
    data = source.data;
  } else {
    return null;
  }
  const parsed = parseDataUrl(data);
  return {
    mimeType: declared ?? parsed.mimeType ?? "application/octet-stream",
    base64: parsed.base64,
  };
}

export function formatImagePlaceholder(mimeType: string, bytes: Buffer): string {
  const kb = (bytes.byteLength / 1024).toFixed(1);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return `[image: ${mimeType}, ${kb} KB, sha256:${sha}]`;
}

/**
 * Copy-on-write deep scrub: returns `value` itself when it holds no image blocks, else a
 * copy where every image block (at any depth, e.g. a toolResult's content or `details`)
 * is replaced by its text placeholder. Never mutates its input.
 */
export function scrubImageBlocksDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item: unknown) => {
      const image = readImageBlock(item);
      if (image) {
        changed = true;
        const bytes = Buffer.from(image.base64, "base64");
        return { type: "text", text: formatImagePlaceholder(image.mimeType, bytes) };
      }
      const scrubbed = scrubImageBlocksDeep(item);
      if (scrubbed !== item) {
        changed = true;
      }
      return scrubbed;
    });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === "object") {
    let next: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const scrubbed = scrubImageBlocksDeep(item);
      if (scrubbed !== item) {
        next ??= { ...(value as Record<string, unknown>) };
        next[key] = scrubbed;
      }
    }
    return (next ?? value) as T;
  }
  return value;
}

/**
 * Returns a copy of `message` whose image blocks are replaced by text placeholders,
 * or the original object when it carries no image blocks. Never mutates its input.
 */
export function replaceImageBlocksForPersistence(message: AgentMessage): AgentMessage {
  return scrubImageBlocksDeep(message);
}

const INSTALLED = Symbol.for("openclaw.sessionImagePlaceholder");

type EntrySink = { _appendEntry?: (entry: unknown) => unknown; [INSTALLED]?: true };

/**
 * Makes `sessionManager` write image blocks to disk as placeholders while its in-memory
 * entries keep the original image (pi-coding-agent rebuilds the agent's messages from
 * those entries after a compaction, so they must stay intact).
 *
 * Every entry appended from now on gets a non-enumerable `toJSON` that serialises the
 * scrubbed copy, so every disk write path (append, rewrite, branch) stores the placeholder.
 * If the library internals are not what we expect, falls back to persisting a scrubbed
 * copy at appendMessage (the image then leaves memory too, but never reaches disk).
 */
export function installSessionImagePlaceholderPersistence(sessionManager: SessionManager): void {
  const sink = sessionManager as unknown as EntrySink;
  if (sink[INSTALLED]) {
    return;
  }
  Object.defineProperty(sink, INSTALLED, { value: true });
  const appendEntry = sink._appendEntry;
  if (typeof appendEntry === "function") {
    sink._appendEntry = (entry: unknown) => {
      attachDiskSerializer(entry);
      return appendEntry.call(sessionManager, entry);
    };
    return;
  }
  const appendMessage = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = ((message: AgentMessage) =>
    appendMessage(
      replaceImageBlocksForPersistence(message) as never,
    )) as SessionManager["appendMessage"];
}

function attachDiskSerializer(entry: unknown): void {
  if (!entry || typeof entry !== "object" || scrubImageBlocksDeep(entry) === entry) {
    return;
  }
  Object.defineProperty(entry, "toJSON", {
    configurable: true,
    enumerable: false,
    value(this: Record<string, unknown>) {
      return scrubImageBlocksDeep({ ...this });
    },
  });
}
