/**
 * mono #544 — session-transcript retention. RED arm (CTO #15035): an aged fixture
 * file is removed under enforce. Measured staging shape: unindexed transcripts and
 * archived renames must be covered; sessions.json, locks, temp files must never be.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenClawSchema } from "../zod-schema.js";
import {
  createTranscriptRetentionRunner,
  resolveSessionDirs,
  resolveTranscriptRetention,
  sweepSessionTranscripts,
} from "./transcript-retention.js";

const DAY = 864e5;
const NOW = Date.UTC(2026, 9, 18);
const ENFORCE = { maxAgeMs: 30 * DAY, mode: "enforce" as const };
let state: string;

function age(p: string, days: number) {
  const t = new Date(NOW - days * DAY);
  fs.utimesSync(p, t, t);
}
function file(dir: string, name: string, ageDays: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  age(p, ageDays);
  return p;
}
const sessions = (agent: string) => path.join(state, "agents", agent, "sessions");
const sweep = (settings = ENFORCE) =>
  sweepSessionTranscripts({ dirs: resolveSessionDirs(state), settings, now: NOW });

beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "oc-retention-"));
});
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

describe("sweepSessionTranscripts", () => {
  it("enforce: removes aged transcripts (live, unindexed, archived) in every agent; keeps fresh + non-transcripts", () => {
    const aged = file(sessions("main"), "old.jsonl", 40);
    const agedArchived = file(sessions("main"), "x.jsonl.deleted.2026-08-01T00-00-00", 45);
    const agedReset = file(sessions("other"), "y.jsonl.reset.2026-08-01", 31);
    const fresh = file(sessions("main"), "new.jsonl", 3);
    const keep = [
      file(sessions("main"), "sessions.json", 400),
      file(sessions("main"), "sessions.json.bak.1", 400),
      file(sessions("main"), "sessions.json.123.abc.tmp", 400),
    ];
    const r = sweep();
    expect(fs.existsSync(aged)).toBe(false); // the RED arm
    expect(fs.existsSync(agedArchived)).toBe(false);
    expect(fs.existsSync(agedReset)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    for (const k of keep) {
      expect(fs.existsSync(k)).toBe(true);
    }
    expect(r).toMatchObject({ scanned: 4, expired: 3, deleted: 3, errors: 0 });
  });

  it("warn: counts, deletes nothing", () => {
    const aged = file(sessions("main"), "old.jsonl", 40);
    const r = sweep({ maxAgeMs: 30 * DAY, mode: "warn" });
    expect(fs.existsSync(aged)).toBe(true);
    expect(r).toMatchObject({ expired: 1, deleted: 0 });
  });

  it("skips an aged transcript whose session write lock is held (no TOCTOU corruption)", () => {
    const aged = file(sessions("main"), "busy.jsonl", 40);
    const lock = file(sessions("main"), "busy.jsonl.lock", 0);
    const r = sweep();
    expect(fs.existsSync(aged)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
    expect(r).toMatchObject({ expired: 1, deleted: 0, skippedLocked: 1 });
  });

  it("never follows symlinks: a linked transcript and a linked sessions dir leave their targets intact", () => {
    const outside = path.join(state, "outside");
    const target = file(outside, "victim.jsonl", 400);
    fs.mkdirSync(sessions("main"), { recursive: true });
    fs.symlinkSync(target, path.join(sessions("main"), "link.jsonl"));
    fs.mkdirSync(path.join(state, "agents", "evil"), { recursive: true });
    fs.symlinkSync(outside, sessions("evil"));
    sweep();
    expect(fs.existsSync(target)).toBe(true);
  });

  it("acceptance shape: after an enforce pass, a re-list shows nothing older than N", () => {
    for (const d of [1, 10, 29, 31, 60, 120]) {
      file(sessions("main"), `s${d}.jsonl`, d);
    }
    sweep();
    const dir = sessions("main");
    const ages = fs
      .readdirSync(dir)
      .map((n) => (NOW - fs.statSync(path.join(dir, n)).mtimeMs) / DAY);
    expect(ages.length).toBe(3);
    expect(Math.max(...ages)).toBeLessThan(30);
  });

  it("no agents dir: a no-op, not an error", () => {
    expect(sweep()).toMatchObject({ dirs: 0, scanned: 0, errors: 0 });
  });
});

describe("resolveSessionDirs", () => {
  it("includes a custom session.store dir ({agentId} template) for each configured agent", () => {
    const custom = path.join(state, "custom");
    const aged = file(path.join(custom, "main"), "c.jsonl", 40);
    const dirs = resolveSessionDirs(state, {
      session: { store: path.join(custom, "{agentId}", "sessions.json") },
    } as never);
    expect(dirs).toContain(path.join(custom, "main"));
    sweepSessionTranscripts({ dirs, settings: ENFORCE, now: NOW });
    expect(fs.existsSync(aged)).toBe(false);
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
  it("invalid, zero, or below the 1d floor never yields settings", () => {
    for (const maxAge of ["soon", 0, "5m", "23h"]) {
      expect(
        resolveTranscriptRetention({
          session: { maintenance: { transcriptRetention: { maxAge } } },
        }),
      ).toBeNull();
    }
  });
});

describe("createTranscriptRetentionRunner", () => {
  it("runs at most once per interval; absent config = no sweep", () => {
    let loads = 0;
    const cfg = { session: { maintenance: { transcriptRetention: { maxAge: "30d" } } } } as never;
    const runner = createTranscriptRetentionRunner({
      intervalMs: 3600_000,
      stateDir: () => state,
      loadConfigFn: () => (loads++, cfg),
      onResult: () => {},
    });
    expect(runner.maybeRun(NOW)).not.toBeNull();
    expect(runner.maybeRun(NOW + 60_000)).toBeNull();
    expect(runner.maybeRun(NOW + 3600_000)).not.toBeNull();
    expect(loads).toBe(2);
    const off = createTranscriptRetentionRunner({
      stateDir: () => state,
      loadConfigFn: () => ({}) as never,
    });
    expect(off.maybeRun(NOW)).toBeNull();
  });
});

describe("config schema: session.maintenance.transcriptRetention", () => {
  it("the SHIPPED openclaw.json validates and carries 30d", () => {
    const shipped = JSON.parse(
      fs.readFileSync(new URL("../../../openclaw.json", import.meta.url), "utf8"),
    ) as { session?: { maintenance?: { transcriptRetention?: { maxAge?: string } } } };
    expect(shipped.session?.maintenance?.transcriptRetention?.maxAge).toBe("30d");
    expect(
      OpenClawSchema.safeParse({ session: { maintenance: shipped.session?.maintenance } }).success,
    ).toBe(true);
  });
  it("rejects a bad duration, below-floor values, an unknown mode and unknown keys", () => {
    for (const tr of [
      { maxAge: "soon" },
      { maxAge: 0 },
      { maxAge: "5m" },
      { maxAge: "30d", mode: "delete" },
      { maxAge: "30d", extra: 1 },
    ]) {
      expect(
        OpenClawSchema.safeParse({ session: { maintenance: { transcriptRetention: tr } } }).success,
      ).toBe(false);
    }
  });
});
