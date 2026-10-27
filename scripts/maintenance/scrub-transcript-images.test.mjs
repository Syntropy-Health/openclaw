#!/usr/bin/env node
/**
 * Smoke tests for scrub-transcript-images.mjs.
 *
 * Run with `node scripts/maintenance/scrub-transcript-images.test.mjs`. Exits 0 on
 * success, non-zero on failure. No vitest dep, like scripts/fly/bootstrap-config.test.mjs.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "scrub-transcript-images.mjs");

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) {
    pass += 1;
    process.stdout.write(`  ok  ${msg}\n`);
  } else {
    fail += 1;
    process.stdout.write(`  FAIL ${msg}\n`);
  }
}

// 3000 deterministic bytes -> "2.9 KB", the same placeholder format the runtime writes.
const IMAGE_BYTES = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
const IMAGE_B64 = IMAGE_BYTES.toString("base64");
const SHA12 = crypto.createHash("sha256").update(IMAGE_BYTES).digest("hex").slice(0, 12);
const PLACEHOLDER = `[image: image/jpeg, 2.9 KB, sha256:${SHA12}]`;

const header = JSON.stringify({ type: "session", version: 3, id: "sess-secret-id" });
const userWithImage = JSON.stringify({
  type: "message",
  id: "m1",
  message: {
    role: "user",
    content: [
      { type: "text", text: "what did I eat?" },
      { type: "image", data: IMAGE_B64, mimeType: "image/jpeg" },
    ],
  },
});
const assistantText = JSON.stringify({
  type: "message",
  id: "m2",
  message: { role: "assistant", content: [{ type: "text", text: "oatmeal" }] },
});
const toolResultWithImage = JSON.stringify({
  type: "message",
  id: "m3",
  message: {
    role: "toolResult",
    toolCallId: "c1",
    content: [{ type: "image", data: IMAGE_B64, mimeType: "image/jpeg" }],
  },
});

function setupFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-transcript-images-"));
  const files = {
    image: path.join(dir, "aaa-image.jsonl"),
    text: path.join(dir, "bbb-text.jsonl.reset.2026-10-01T00-00-00Z"),
    locked: path.join(dir, "ccc-locked.jsonl"),
  };
  fs.writeFileSync(
    files.image,
    [header, userWithImage, assistantText, toolResultWithImage, ""].join("\n"),
  );
  fs.writeFileSync(files.text, [header, assistantText, ""].join("\n"));
  fs.writeFileSync(files.locked, [header, userWithImage, ""].join("\n"));
  fs.writeFileSync(`${files.locked}.lock`, "");
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ k: { data: IMAGE_B64 } }));
  return { dir, files };
}

function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).slice().toSorted()) {
    out[name] = fs.readFileSync(path.join(dir, name), "utf8");
  }
  return out;
}

function run(dir, extra = []) {
  const stdout = execFileSync("node", [SCRIPT, "--dir", dir, ...extra], { encoding: "utf8" });
  return { stdout, report: JSON.parse(stdout.trim()) };
}

function test_dryRunChangesNothingAndCounts() {
  process.stdout.write("test_dryRunChangesNothingAndCounts\n");
  const { dir, files } = setupFixtures();
  const before = snapshot(dir);
  const { stdout, report } = run(dir);
  assert(JSON.stringify(snapshot(dir)) === JSON.stringify(before), "dry run: no file changed");
  assert(stdout.trim().split("\n").length === 1, "output is exactly one line");
  assert(report.applied === false, "applied=false");
  assert(report.files_scanned === 2, `files_scanned=2 (got ${report.files_scanned})`);
  assert(report.files_with_images === 1, `files_with_images=1 (got ${report.files_with_images})`);
  assert(report.image_blocks === 2, `image_blocks=2 (got ${report.image_blocks})`);
  assert(report.locked_skipped === 1, `locked_skipped=1 (got ${report.locked_skipped})`);
  const imageSize = fs.statSync(files.image).size;
  assert(report.bytes_before === imageSize, "bytes_before = size of the affected file");
  assert(report.bytes_after < report.bytes_before, "bytes_after < bytes_before");
  for (const leak of ["aaa-image", "ccc-locked", "sess-secret-id", "oatmeal", dir]) {
    assert(!stdout.includes(leak), `output does not contain ${JSON.stringify(leak)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function test_applyRewritesOnlyTheImageFile() {
  process.stdout.write("test_applyRewritesOnlyTheImageFile\n");
  const { dir, files } = setupFixtures();
  const before = snapshot(dir);
  const past = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  fs.utimesSync(files.image, past, past);
  const mtimeBefore = fs.statSync(files.image).mtimeMs;
  const { report } = run(dir, ["--apply"]);
  const after = snapshot(dir);

  assert(report.applied === true, "applied=true");
  assert(report.image_blocks === 2, "image_blocks=2");
  const rewritten = after[path.basename(files.image)];
  assert(!rewritten.includes(IMAGE_B64), "image file: 0 base64 left");
  assert(rewritten.split(PLACEHOLDER).length - 1 === 2, "image file: 2 placeholders");
  assert(report.bytes_after === Buffer.byteLength(rewritten), "bytes_after = new file size");
  const oldLines = before[path.basename(files.image)].split("\n");
  const newLines = rewritten.split("\n");
  assert(oldLines.length === newLines.length, "same line count");
  assert(
    oldLines[0] === newLines[0] && oldLines[2] === newLines[2] && oldLines[4] === newLines[4],
    "lines without images are byte-identical",
  );
  const user = JSON.parse(newLines[1]);
  assert(
    JSON.stringify(user.message.content) ===
      JSON.stringify([
        { type: "text", text: "what did I eat?" },
        { type: "text", text: PLACEHOLDER },
      ]),
    "user image replaced in place, text kept",
  );
  assert(fs.statSync(files.image).mtimeMs === mtimeBefore, "mtime preserved (retention age)");
  for (const name of Object.keys(before)) {
    if (name !== path.basename(files.image)) {
      assert(after[name] === before[name], `${name.split("-")[0]}: untouched`);
    }
  }
  assert(
    JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(before)),
    "no temp files left behind",
  );
  const again = run(dir, ["--apply"]).report;
  assert(again.image_blocks === 0 && again.files_with_images === 0, "second apply: idempotent");
  fs.rmSync(dir, { recursive: true, force: true });
}

function test_applyKeepsModeAndOwnershipAndReleasesLock() {
  process.stdout.write("test_applyKeepsModeAndOwnershipAndReleasesLock\n");
  const { dir, files } = setupFixtures();
  fs.chmodSync(files.image, 0o600);
  const before = fs.statSync(files.image);
  const { report } = run(dir, ["--apply"]);
  const after = fs.statSync(files.image);
  assert(report.image_blocks === 2, "image file rewritten");
  assert(
    (after.mode & 0o7777) === 0o600,
    `mode 0600 kept (got ${(after.mode & 0o7777).toString(8)})`,
  );
  assert(after.uid === before.uid && after.gid === before.gid, "uid/gid kept");
  assert(after.ino !== before.ino, "rewritten via rename (new inode)");
  assert(!fs.existsSync(`${files.image}.lock`), "session lock released after apply");
  fs.rmSync(dir, { recursive: true, force: true });
}

function test_existingLockIsSkippedInApply() {
  process.stdout.write("test_existingLockIsSkippedInApply\n");
  const { dir, files } = setupFixtures();
  const lockBody = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
  fs.writeFileSync(`${files.locked}.lock`, lockBody);
  const before = fs.readFileSync(files.locked, "utf8");
  const { report } = run(dir, ["--apply"]);
  assert(report.locked_skipped === 1, "locked file counted as locked_skipped");
  assert(fs.readFileSync(files.locked, "utf8") === before, "locked file untouched");
  assert(fs.readFileSync(`${files.locked}.lock`, "utf8") === lockBody, "foreign lock not removed");
  fs.rmSync(dir, { recursive: true, force: true });
}

async function test_concurrentChangeAbortsTheFile() {
  process.stdout.write("test_concurrentChangeAbortsTheFile\n");
  const { scrubDirectory } = await import(pathToFileURL(SCRIPT).href);
  const { dir, files } = setupFixtures();
  const appended = `${JSON.stringify({ type: "message", id: "m9", message: { role: "user", content: "late" } })}\n`;
  const report = await scrubDirectory(
    { dir, apply: true },
    {
      beforeRename: (file) => {
        if (file === files.image) {
          fs.appendFileSync(file, appended); // a gateway append lands mid-scrub
        }
      },
    },
  );
  const content = fs.readFileSync(files.image, "utf8");
  assert(report.changed_skipped === 1, `changed_skipped=1 (got ${report.changed_skipped})`);
  assert(content.endsWith(appended), "the concurrent append is kept (nothing lost)");
  assert(content.includes(IMAGE_B64), "aborted file left as it was (not rewritten)");
  assert(
    fs.readdirSync(dir).every((n) => !n.endsWith(".tmp")),
    "temp file removed after abort",
  );
  assert(!fs.existsSync(`${files.image}.lock`), "lock released after abort");
  fs.rmSync(dir, { recursive: true, force: true });
}

async function test_chownRefusalSkipsTheFile() {
  process.stdout.write("test_chownRefusalSkipsTheFile\n");
  const { scrubDirectory } = await import(pathToFileURL(SCRIPT).href);
  const { dir, files } = setupFixtures();
  const before = fs.readFileSync(files.image, "utf8");
  const report = await scrubDirectory(
    { dir, apply: true },
    {
      fchown: () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      },
    },
  );
  assert(report.ownership_skipped === 1, `ownership_skipped=1 (got ${report.ownership_skipped})`);
  assert(fs.readFileSync(files.image, "utf8") === before, "file untouched when chown refused");
  assert(
    fs.readdirSync(dir).every((n) => !n.endsWith(".tmp")),
    "temp file removed after refusal",
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

function test_symlinkIsUntouched() {
  process.stdout.write("test_symlinkIsUntouched\n");
  const { dir, files } = setupFixtures();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-target-"));
  const target = path.join(outside, "target.jsonl");
  fs.writeFileSync(target, [header, userWithImage, ""].join("\n"));
  const link = path.join(dir, "ddd-link.jsonl");
  fs.symlinkSync(target, link);
  const before = fs.readFileSync(target, "utf8");
  fs.rmSync(files.image); // leave only the symlink as an image-bearing candidate
  const { report } = run(dir, ["--apply"]);
  assert(fs.lstatSync(link).isSymbolicLink(), "symlink still a symlink");
  assert(fs.readFileSync(target, "utf8") === before, "symlink target untouched");
  assert(report.image_blocks === 0, "symlink not scanned");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

function test_streamsLinesAcrossChunkBoundaries() {
  process.stdout.write("test_streamsLinesAcrossChunkBoundaries\n");
  // A 1.5 MiB image line spans the 1 MiB read chunk; text lines around it stay byte-identical.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-transcript-images-big-"));
  const big = Buffer.alloc(1536 * 1024, 3);
  const bigSha = crypto.createHash("sha256").update(big).digest("hex").slice(0, 12);
  const bigLine = JSON.stringify({
    type: "message",
    id: "b1",
    message: {
      role: "user",
      content: [{ type: "image", data: big.toString("base64"), mimeType: "image/png" }],
    },
  });
  const file = path.join(dir, "big.jsonl");
  fs.writeFileSync(file, [header, bigLine, assistantText].join("\r\n")); // CRLF, no final newline
  const { report } = run(dir, ["--apply"]);
  const out = fs.readFileSync(file, "utf8");
  assert(report.image_blocks === 1, "big image counted once");
  assert(out.includes(`[image: image/png, 1536.0 KB, sha256:${bigSha}]`), "big image placeholder");
  const lines = out.split("\r\n");
  assert(
    lines.length === 3 && lines[0] === header && lines[2] === assistantText,
    "CRLF + other lines kept",
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

test_dryRunChangesNothingAndCounts();
test_applyRewritesOnlyTheImageFile();
test_applyKeepsModeAndOwnershipAndReleasesLock();
test_existingLockIsSkippedInApply();
await test_concurrentChangeAbortsTheFile();
await test_chownRefusalSkipsTheFile();
test_symlinkIsUntouched();
test_streamsLinesAcrossChunkBoundaries();

process.stdout.write(`\nresult: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
