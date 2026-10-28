import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectImageReferences } from "./pi-embedded-runner/run/images.js";
import {
  replaceImageBlocksForPersistence,
  scrubImageBlocksDeep,
} from "./session-image-placeholder.js";

const SCRUB_SCRIPT = fileURLToPath(
  new URL("../../scripts/maintenance/scrub-transcript-images.mjs", import.meta.url),
);

const BYTES = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
const B64 = BYTES.toString("base64");
const SHA12 = crypto.createHash("sha256").update(BYTES).digest("hex").slice(0, 12);
const PLACEHOLDER = `[image: image/png, 4.9 KB, sha256:${SHA12}]`;

const SHAPES: Record<string, unknown> = {
  raw: { type: "image", data: B64, mimeType: "image/png" },
  anthropic: { type: "image", source: { type: "base64", media_type: "image/png", data: B64 } },
  dataUrl: { type: "image", data: `data:image/png;base64,${B64}`, mimeType: "image/png" },
  dataUrlWithParams: { type: "image", data: `data:image/png;name=x.png;base64,${B64}` },
  anthropicDataUrl: {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: `data:image/png;name=x;base64,${B64}`,
    },
  },
};

function userMessage(block: unknown) {
  return { role: "user", content: [{ type: "text", text: "hi" }, block], timestamp: 1 } as never;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("image placeholder", () => {
  it.each(Object.keys(SHAPES))("%s: same placeholder (sha12 + KB) as the raw form", (shape) => {
    const out = replaceImageBlocksForPersistence(userMessage(SHAPES[shape])) as {
      content: unknown[];
    };
    expect(out.content[1]).toEqual({ type: "text", text: PLACEHOLDER });
  });

  it("the scrub script produces the same placeholder for every shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "placeholder-parity-"));
    tmpDirs.push(dir);
    const lines = Object.values(SHAPES).map((block, i) =>
      JSON.stringify({ type: "message", id: `m${i}`, message: userMessage(block) }),
    );
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    execFileSync("node", [SCRUB_SCRIPT, "--dir", dir, "--apply", "--gateway-stopped"], {
      encoding: "utf8",
    });
    const out = fs.readFileSync(file, "utf8");
    expect(out).not.toContain(B64);
    expect(out.split(PLACEHOLDER).length - 1).toBe(lines.length);
  });

  it("recurses into nested content (toolResult content, details)", () => {
    const message = {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "shot" }],
      details: { screenshots: [SHAPES.raw], nested: { content: [SHAPES.anthropic] } },
      timestamp: 1,
    };
    const out = scrubImageBlocksDeep(message);
    expect(out).not.toBe(message);
    expect(JSON.stringify(out)).not.toContain(B64);
    expect(JSON.stringify(out).split(PLACEHOLDER).length - 1).toBe(2);
    expect(message.details.screenshots[0]).toBe(SHAPES.raw); // input not mutated
  });

  it("a placeholder is never detected as an image reference", () => {
    expect(detectImageReferences(PLACEHOLDER)).toEqual([]);
    expect(detectImageReferences(`see ${PLACEHOLDER} please`)).toEqual([]);
  });
});
