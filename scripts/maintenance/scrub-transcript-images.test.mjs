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
import { fileURLToPath } from "node:url";

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

test_dryRunChangesNothingAndCounts();
test_applyRewritesOnlyTheImageFile();

process.stdout.write(`\nresult: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
