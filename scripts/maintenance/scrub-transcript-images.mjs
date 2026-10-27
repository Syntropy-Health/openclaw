#!/usr/bin/env node
/**
 * One-off scrub: replace base64 image blocks in session transcripts with a text placeholder.
 *
 *   node scrub-transcript-images.mjs [--dir /data/agents/main/sessions] [--apply]
 *
 * Standalone (no repo imports) so it can be copied to and run on a gateway host.
 *
 * RECOMMENDED: run with the gateway STOPPED, or at least idle. The script takes the same
 * per-transcript session lock the gateway's writer uses and aborts a file that changes
 * under it, but a stopped gateway removes the race entirely.
 *
 * - Default is a DRY RUN: nothing is written; the counts say what --apply would change.
 * - Scans `*.jsonl` and archived `*.jsonl.*` transcripts in --dir (not recursive).
 *   Lock files, temp files, sessions.json and symlinks are never touched.
 * - A transcript whose `<file>.lock` exists is in use: it is skipped (`locked_skipped`).
 *   With --apply the script itself takes that lock (O_EXCL, `{pid, createdAt}` JSON, the
 *   gateway's format) for the rewrite and releases it in `finally`.
 * - --apply rewrites each affected file atomically: a temp file in the same dir gets the
 *   original uid/gid (fchown) and mode (fchmod), is fsynced, keeps the original mtime, then
 *   is renamed over the original. If chown is not permitted the file is refused
 *   (`ownership_skipped`): it never leaves a file the gateway cannot append to. If the
 *   file's size, mtime or inode changed while it was being rewritten, the rewrite is
 *   dropped (`changed_skipped`) and the original, with the new data, stays as it is.
 * - Files are streamed line by line; lines without images are kept byte-identical.
 * - Output is ONE JSON line of counts. It never prints content, file names or session ids.
 *
 * Placeholder (same format as src/agents/session-image-placeholder.ts):
 *   [image: <mimeType>, <KB> KB, sha256:<first 12 hex of sha256(decoded bytes)>]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = "/data/agents/main/sessions";
const TRANSCRIPT_FILE = /\.jsonl(\..+)?$/;
const NOT_A_TRANSCRIPT = /\.(lock|tmp)$/;
const CHUNK_BYTES = 1024 * 1024;
const IMAGE_MARKER = Buffer.from('"image"');
const NEWLINE = 0x0a;

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

function parseDataUrl(data) {
  // data:<mime>[;param=value]*;base64,<payload>
  const match = /^data:([^;,]*)((?:;[^;,]*)*);base64,/i.exec(data);
  if (!match) {
    return { mimeType: undefined, base64: data };
  }
  return { mimeType: match[1] || undefined, base64: data.slice(match[0].length) };
}

function readImageBlock(block) {
  if (!block || typeof block !== "object" || block.type !== "image") {
    return null;
  }
  let declared;
  let data;
  if (typeof block.data === "string") {
    declared = typeof block.mimeType === "string" ? block.mimeType : undefined;
    data = block.data;
  } else if (
    block.source &&
    block.source.type === "base64" &&
    typeof block.source.data === "string"
  ) {
    declared = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
    data = block.source.data;
  } else {
    return null;
  }
  const parsed = parseDataUrl(data);
  return {
    mimeType: declared ?? parsed.mimeType ?? "application/octet-stream",
    base64: parsed.base64,
  };
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

/** One line (without its "\n") in, the bytes to write and the image count out. */
function scrubLine(lineBuf) {
  if (lineBuf.indexOf(IMAGE_MARKER) === -1) {
    return { out: lineBuf, images: 0 };
  }
  let text = lineBuf.toString("utf8");
  const cr = text.endsWith("\r") ? "\r" : "";
  if (cr) {
    text = text.slice(0, -1);
  }
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return { out: lineBuf, images: 0 }; // not JSON: leave it exactly as it is
  }
  const images = scrubValue(entry);
  if (images === 0) {
    return { out: lineBuf, images: 0 };
  }
  return { out: Buffer.from(JSON.stringify(entry) + cr, "utf8"), images };
}

/**
 * Streams `file` line by line. `write(buf)` (optional) receives the output bytes.
 * Returns { images, bytesIn, bytesOut }.
 */
function streamScrub(file, write) {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let images = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  const emit = (buf) => {
    bytesOut += buf.length;
    if (write) {
      write(buf);
    }
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (n === 0) {
        break;
      }
      bytesIn += n;
      let data =
        pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(NEWLINE, start); nl !== -1; nl = data.indexOf(NEWLINE, start)) {
        const result = scrubLine(data.subarray(start, nl));
        images += result.images;
        emit(result.out);
        emit(Buffer.from([NEWLINE]));
        start = nl + 1;
      }
      pending = Buffer.from(data.subarray(start)); // copy: `chunk` is reused
      data = undefined;
    }
    if (pending.length > 0) {
      const result = scrubLine(pending);
      images += result.images;
      emit(result.out);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { images, bytesIn, bytesOut };
}

function acquireSessionLock(file) {
  let dir = path.dirname(file);
  try {
    dir = fs.realpathSync(dir);
  } catch {
    // keep the resolved dir
  }
  const lockPath = path.join(dir, `${path.basename(file)}.lock`);
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return null;
    }
    throw err;
  }
  try {
    fs.writeSync(
      fd,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
    );
  } finally {
    fs.closeSync(fd);
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone
    }
  };
}

function sameFile(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function rewriteFile(file, report, hooks) {
  const release = acquireSessionLock(file);
  if (!release) {
    report.locked_skipped += 1;
    return;
  }
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.scrub-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  let renamed = false;
  try {
    const before = fs.lstatSync(file);
    fd = fs.openSync(tmp, "wx", 0o600);
    try {
      (hooks.fchown ?? fs.fchownSync)(fd, before.uid, before.gid);
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        report.ownership_skipped += 1;
        return;
      }
      throw err;
    }
    fs.fchmodSync(fd, before.mode & 0o7777);
    const out = fd;
    streamScrub(file, (buf) => {
      fs.writeSync(out, buf);
    });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.utimesSync(tmp, before.atime, before.mtime);
    hooks.beforeRename?.(file);
    const now = fs.lstatSync(file);
    if (!sameFile(before, now)) {
      report.changed_skipped += 1;
      return;
    }
    fs.renameSync(tmp, file);
    renamed = true;
    report.files_rewritten += 1;
    try {
      const dirFd = fs.openSync(dir, "r");
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {
      // directory fsync is best-effort (not supported on every platform)
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // never created, or already gone
      }
    }
    release();
  }
}

/**
 * Scans (and with `apply`, rewrites) the transcripts in `opts.dir`.
 * `hooks` are test seams only: { beforeRename(file), fchown(fd, uid, gid) }.
 */
export async function scrubDirectory(opts, hooks = {}) {
  const report = {
    files_scanned: 0,
    files_with_images: 0,
    image_blocks: 0,
    bytes_before: 0,
    bytes_after: 0,
    applied: Boolean(opts.apply),
    files_rewritten: 0,
    locked_skipped: 0,
    changed_skipped: 0,
    ownership_skipped: 0,
    not_regular_skipped: 0,
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
      report.not_regular_skipped += 1; // symlinks and directories are not ours to rewrite
      continue;
    }
    if (present.has(`${name}.lock`) || fs.existsSync(`${file}.lock`)) {
      report.locked_skipped += 1;
      continue;
    }
    report.files_scanned += 1;
    try {
      const counted = streamScrub(file);
      if (counted.images === 0) {
        continue;
      }
      report.files_with_images += 1;
      report.image_blocks += counted.images;
      report.bytes_before += counted.bytesIn;
      report.bytes_after += counted.bytesOut;
      if (opts.apply) {
        rewriteFile(file, report, hooks);
      }
    } catch {
      report.errors += 1;
    }
  }
  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await scrubDirectory(opts);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.errors > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    // Never echo paths: only the error class and code.
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    process.stderr.write(`scrub-transcript-images: failed (${err?.name ?? "Error"} ${code})\n`);
    process.exitCode = 2;
  });
}
