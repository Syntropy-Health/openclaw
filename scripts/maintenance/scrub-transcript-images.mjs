#!/usr/bin/env node
/**
 * One-off scrub: replace base64 image blocks in session transcripts with a text placeholder.
 *
 *   node scrub-transcript-images.mjs [--dir /data/agents/main/sessions] [--apply]
 *
 * Standalone (no repo imports) so it can be copied to and run on a gateway host.
 *
 * - Default is a DRY RUN: nothing is written; the counts say what --apply would change.
 * - Scans `*.jsonl` and archived `*.jsonl.*` transcripts in --dir (not recursive).
 *   Lock files, temp files and sessions.json are never touched.
 * - A transcript with a `<file>.lock` sibling is in use: it is skipped and counted.
 * - --apply rewrites each affected file atomically (temp file in the same dir, fsync,
 *   rename) and keeps its mode and mtime, so transcript retention ages it as before.
 *   Lines without images are kept byte-identical.
 * - Output is ONE JSON line of counts. It never prints content, file names or session ids.
 *
 * Placeholder (same format as src/agents/session-image-placeholder.ts):
 *   [image: <mimeType>, <KB> KB, sha256:<first 12 hex of sha256(decoded bytes)>]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DIR = "/data/agents/main/sessions";
const TRANSCRIPT_FILE = /\.jsonl(\..+)?$/;
const NOT_A_TRANSCRIPT = /\.(lock|tmp)$/;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dir: DEFAULT_DIR, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      opts.apply = true;
    } else if (arg === "--dir") {
      opts.dir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--dir=")) {
      opts.dir = arg.slice("--dir=".length);
    } else {
      throw new UsageError("usage: scrub-transcript-images.mjs [--dir <sessions dir>] [--apply]");
    }
  }
  if (!opts.dir) {
    throw new UsageError("--dir needs a value");
  }
  return opts;
}

function stripDataUrlPrefix(data) {
  const match = /^data:[^;,]*;base64,/i.exec(data);
  return match ? data.slice(match[0].length) : data;
}

function readImageBlock(block) {
  if (!block || typeof block !== "object" || block.type !== "image") {
    return null;
  }
  if (typeof block.data === "string") {
    return {
      mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
      base64: stripDataUrlPrefix(block.data),
    };
  }
  const source = block.source;
  if (source && source.type === "base64" && typeof source.data === "string") {
    return {
      mimeType:
        typeof source.media_type === "string" ? source.media_type : "application/octet-stream",
      base64: stripDataUrlPrefix(source.data),
    };
  }
  return null;
}

function formatImagePlaceholder(mimeType, bytes) {
  const kb = (bytes.byteLength / 1024).toFixed(1);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return `[image: ${mimeType}, ${kb} KB, sha256:${sha}]`;
}

/** Replaces image blocks anywhere in a parsed entry, in place. Returns the count. */
function scrubValue(value) {
  let count = 0;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const image = readImageBlock(value[i]);
      if (image) {
        const bytes = Buffer.from(image.base64, "base64");
        value[i] = { type: "text", text: formatImagePlaceholder(image.mimeType, bytes) };
        count += 1;
      } else {
        count += scrubValue(value[i]);
      }
    }
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      count += scrubValue(value[key]);
    }
  }
  return count;
}

/** Returns { text, imageBlocks } for one file's content. Unchanged lines keep their bytes. */
function scrubContent(content) {
  let imageBlocks = 0;
  const lines = content.split("\n");
  const out = lines.map((line) => {
    // Cheap pre-filter: most lines carry no image at all.
    if (!line.includes('"image"')) {
      return line;
    }
    const cr = line.endsWith("\r") ? "\r" : "";
    let entry;
    try {
      entry = JSON.parse(cr ? line.slice(0, -1) : line);
    } catch {
      return line; // not JSON: leave it exactly as it is
    }
    const n = scrubValue(entry);
    if (n === 0) {
      return line;
    }
    imageBlocks += n;
    return JSON.stringify(entry) + cr;
  });
  return { text: out.join("\n"), imageBlocks };
}

function writeAtomic(file, text, stat) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.scrub-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", stat.mode & 0o777);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.utimesSync(tmp, stat.atime, stat.mtime);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  try {
    const dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  } catch {
    // directory fsync is best-effort (not supported on every platform)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = {
    files_scanned: 0,
    files_with_images: 0,
    image_blocks: 0,
    bytes_before: 0,
    bytes_after: 0,
    applied: opts.apply,
    locked_skipped: 0,
    errors: 0,
  };
  const names = fs.readdirSync(opts.dir).toSorted();
  const present = new Set(names);
  for (const name of names) {
    if (!TRANSCRIPT_FILE.test(name) || NOT_A_TRANSCRIPT.test(name)) {
      continue;
    }
    const file = path.join(opts.dir, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue; // removed concurrently
    }
    if (!stat.isFile()) {
      continue; // symlinks and directories are not ours to rewrite
    }
    if (present.has(`${name}.lock`) || fs.existsSync(`${file}.lock`)) {
      report.locked_skipped += 1;
      continue;
    }
    report.files_scanned += 1;
    try {
      const content = fs.readFileSync(file, "utf8");
      const { text, imageBlocks } = scrubContent(content);
      if (imageBlocks === 0) {
        continue;
      }
      report.files_with_images += 1;
      report.image_blocks += imageBlocks;
      report.bytes_before += Buffer.byteLength(content);
      report.bytes_after += Buffer.byteLength(text);
      if (opts.apply) {
        writeAtomic(file, text, stat);
      }
    } catch {
      report.errors += 1;
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.errors > 0 ? 1 : 0;
}

try {
  main();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  // Never echo paths: only the error class and code.
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  process.stderr.write(`scrub-transcript-images: failed (${err?.name ?? "Error"} ${code})\n`);
  process.exitCode = 2;
}
