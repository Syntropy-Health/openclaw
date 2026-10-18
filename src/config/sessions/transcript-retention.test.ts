/**
 * mono #544 — session-transcript retention. RED arm (CTO #15035): an aged fixture
 * file is removed under enforce. Measured staging shape: unindexed transcripts and
 * archived renames must be covered; sessions.json must never be touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenClawSchema } from "../zod-schema.js";
import {
  createTranscriptRetentionRunner,
  resolveTranscriptRetention,
  sweepSessionTranscripts,
} from "./transcript-retention.js";

const DAY = 864e5;
const NOW = Date.UTC(2026, 9, 18);
let state: string;

function file(agent: string, name: string, ageDays: number): string {
  const dir = path.join(state, "agents", agent, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "oc-retention-"));
});
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

describe("sweepSessionTranscripts", () => {
  it("enforce: removes aged transcripts (live, unindexed, archived) in every agent; keeps fresh + non-transcripts", () => {
    const aged = file("main", "old.jsonl", 40);
    const agedArchived = file("main", "x.jsonl.deleted.2026-08-01T00-00-00", 45);
    const agedReset = file("other", "y.jsonl.reset.2026-08-01", 31);
    const fresh = file("main", "new.jsonl", 3);
    const index = file("main", "sessions.json", 400);
    const lock = file("main", "old.jsonl.lock", 400);
    const r = sweepSessionTranscripts({
      stateDir: state,
      settings: { maxAgeMs: 30 * DAY, mode: "enforce" },
      now: NOW,
    });
    expect(fs.existsSync(aged)).toBe(false); // the RED arm
    expect(fs.existsSync(agedArchived)).toBe(false);
    expect(fs.existsSync(agedReset)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(index)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
    expect(r).toMatchObject({ scanned: 4, expired: 3, deleted: 3, errors: 0 });
  });

  it("warn: counts, deletes nothing", () => {
    const aged = file("main", "old.jsonl", 40);
    const r = sweepSessionTranscripts({
      stateDir: state,
      settings: { maxAgeMs: 30 * DAY, mode: "warn" },
      now: NOW,
    });
    expect(fs.existsSync(aged)).toBe(true);
    expect(r).toMatchObject({ expired: 1, deleted: 0 });
  });

  it("acceptance shape: after an enforce pass, a re-list shows nothing older than N", () => {
    for (const d of [1, 10, 29, 31, 60, 120]) {
      file("main", `s${d}.jsonl`, d);
    }
    sweepSessionTranscripts({
      stateDir: state,
      settings: { maxAgeMs: 30 * DAY, mode: "enforce" },
      now: NOW,
    });
    const dir = path.join(state, "agents", "main", "sessions");
    const ages = fs
      .readdirSync(dir)
      .map((n) => (NOW - fs.statSync(path.join(dir, n)).mtimeMs) / DAY);
    expect(ages.length).toBe(3);
    expect(Math.max(...ages)).toBeLessThan(30);
  });

  it("no agents dir: a no-op, not an error", () => {
    expect(
      sweepSessionTranscripts({
        stateDir: state,
        settings: { maxAgeMs: DAY, mode: "enforce" },
        now: NOW,
      }),
    ).toMatchObject({ scanned: 0, errors: 0 });
  });
});

describe("resolveTranscriptRetention", () => {
  it("absent config = no sweep (null)", () => {
    expect(resolveTranscriptRetention(undefined)).toBeNull();
    expect(resolveTranscriptRetention({ session: { maintenance: {} } })).toBeNull();
  });
  it("parses maxAge; mode defaults to warn", () => {
    expect(
      resolveTranscriptRetention({
        session: { maintenance: { transcriptRetention: { maxAge: "30d" } } },
      }),
    ).toEqual({ maxAgeMs: 30 * DAY, mode: "warn" });
    expect(
      resolveTranscriptRetention({
        session: { maintenance: { transcriptRetention: { maxAge: 7, mode: "enforce" } } },
      }),
    ).toEqual({ maxAgeMs: 7 * DAY, mode: "enforce" });
  });
  it("an invalid or zero duration never guesses a value", () => {
    expect(
      resolveTranscriptRetention({
        session: { maintenance: { transcriptRetention: { maxAge: "soon" } } },
      }),
    ).toBeNull();
    expect(
      resolveTranscriptRetention({
        session: { maintenance: { transcriptRetention: { maxAge: 0 } } },
      }),
    ).toBeNull();
  });
});

describe("createTranscriptRetentionRunner", () => {
  it("runs at most once per interval; no settings = no sweep", () => {
    let calls = 0;
    const runner = createTranscriptRetentionRunner({
      intervalMs: 3600_000,
      stateDir: () => state,
      resolveSettings: () => (calls++, { maxAgeMs: 30 * DAY, mode: "warn" }),
      onResult: () => {},
    });
    expect(runner.maybeRun(NOW)).not.toBeNull();
    expect(runner.maybeRun(NOW + 60_000)).toBeNull();
    expect(runner.maybeRun(NOW + 3600_000)).not.toBeNull();
    expect(calls).toBe(2);
    const off = createTranscriptRetentionRunner({
      stateDir: () => state,
      resolveSettings: () => null,
    });
    expect(off.maybeRun(NOW)).toBeNull();
  });
});

describe("config schema: session.maintenance.transcriptRetention", () => {
  it("accepts a valid block and the shipped openclaw.json value", () => {
    const ok = OpenClawSchema.safeParse({
      session: { maintenance: { transcriptRetention: { maxAge: "30d", mode: "warn" } } },
    });
    expect(ok.success).toBe(true);
  });
  it("rejects a bad duration, a zero duration, an unknown mode and unknown keys", () => {
    for (const tr of [
      { maxAge: "soon" },
      { maxAge: 0 },
      { maxAge: "30d", mode: "delete" },
      { maxAge: "30d", extra: 1 },
    ]) {
      expect(
        OpenClawSchema.safeParse({ session: { maintenance: { transcriptRetention: tr } } }).success,
      ).toBe(false);
    }
  });
});
