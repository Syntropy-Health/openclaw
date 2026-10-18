/**
 * Session-transcript retention (mono #544, SMS go-live precondition).
 *
 * Why this exists: core session maintenance prunes `sessions.json` ENTRIES and
 * only RENAMES their transcripts to `<file>.deleted.<ts>`, so transcript content
 * stays on disk forever. It also never sees transcripts that are not indexed
 * (measured on staging 2026-10-18: 30 of 46 transcripts unindexed, 33 older than
 * 30 days). This sweep works on the FILES: every transcript (`*.jsonl`) and every
 * archived transcript (`*.jsonl.deleted.*`, `*.jsonl.reset.*`) in each sessions
 * dir whose mtime is older than `maxAge`.
 *
 * Sessions dirs: `<stateDir>/agents/<agent>/sessions` for every agent on disk,
 * plus the dir of a custom `session.store` (incl. `{agentId}` templates) for
 * every configured agent.
 *
 * Opt-in: with `session.maintenance.transcriptRetention` absent, nothing runs.
 * `mode: "warn"` (the default) only counts; `mode: "enforce"` deletes.
 * Logs carry counts only, never file names or contents.
 *
 * NOT full content retention: `sessions.json` entries (pruned by core
 * `session.maintenance` only in its own "enforce" mode) and derived copies
 * (memory indexes, workspace summaries) are outside this sweep.
 */
import fs from "node:fs";
import path from "node:path";
import { listAgentIds } from "../../agents/agent-scope.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig, type OpenClawConfig } from "../config.js";
import { resolveStateDir } from "../paths.js";
import { resolveStorePath } from "./paths.js";

const log = createSubsystemLogger("sessions/retention");

/** A live or archived transcript. `sessions.json`, locks, temp files are never touched. */
const TRANSCRIPT_FILE = /\.jsonl(\.(deleted|reset)\.[^/\\]+)?$/;

/** Lower bound on maxAge: a tiny value under "enforce" would wipe every idle conversation. */
export const MIN_TRANSCRIPT_RETENTION_MS = 24 * 60 * 60_000;

export type TranscriptRetentionMode = "warn" | "enforce";

export type TranscriptRetentionSettings = {
  maxAgeMs: number;
  mode: TranscriptRetentionMode;
};

export type TranscriptRetentionResult = TranscriptRetentionSettings & {
  dirs: number;
  scanned: number;
  expired: number;
  deleted: number;
  skippedLocked: number;
  errors: number;
};

type RawRetention = { maxAge?: string | number; mode?: TranscriptRetentionMode } | undefined;

function rawRetention(config: unknown): RawRetention {
  return (config as { session?: { maintenance?: { transcriptRetention?: RawRetention } } })?.session
    ?.maintenance?.transcriptRetention;
}

/** Settings from openclaw.json, or null when retention is not configured or invalid (no sweep). */
export function resolveTranscriptRetention(config: unknown): TranscriptRetentionSettings | null {
  const raw = rawRetention(config);
  if (!raw || raw.maxAge === undefined || raw.maxAge === "") {
    return null;
  }
  let maxAgeMs: number;
  try {
    maxAgeMs = parseDurationMs(String(raw.maxAge).trim(), { defaultUnit: "d" });
  } catch {
    // Invalid durations are rejected by the config schema; never guess a value here.
    return null;
  }
  if (!(maxAgeMs >= MIN_TRANSCRIPT_RETENTION_MS)) {
    return null;
  }
  return { maxAgeMs, mode: raw.mode === "enforce" ? "enforce" : "warn" };
}

function isRealDir(d: string): boolean {
  try {
    // lstat: a symlinked dir is NOT followed (it could point anywhere, CWE-59).
    return fs.lstatSync(d).isDirectory();
  } catch {
    return false;
  }
}

/** Every sessions dir to sweep: default agents on disk + a custom session.store per agent. */
export function resolveSessionDirs(stateDir: string, config?: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const agentsRoot = path.join(stateDir, "agents");
  if (isRealDir(agentsRoot)) {
    for (const a of fs.readdirSync(agentsRoot)) {
      const d = path.join(agentsRoot, a, "sessions");
      if (isRealDir(path.join(agentsRoot, a)) && isRealDir(d)) {
        dirs.add(d);
      }
    }
  }
  const store = config?.session?.store?.trim();
  if (store && config) {
    for (const agentId of listAgentIds(config)) {
      try {
        const d = path.dirname(resolveStorePath(store, { agentId }));
        if (isRealDir(d)) {
          dirs.add(d);
        }
      } catch {
        // an unresolvable store path is reported by config validation, not here
      }
    }
  }
  return [...dirs];
}

/** One pass over the given sessions dirs. */
export function sweepSessionTranscripts(params: {
  dirs: string[];
  settings: TranscriptRetentionSettings;
  now?: number;
}): TranscriptRetentionResult {
  const { settings } = params;
  const cutoff = (params.now ?? Date.now()) - settings.maxAgeMs;
  const result: TranscriptRetentionResult = {
    ...settings,
    dirs: params.dirs.length,
    scanned: 0,
    expired: 0,
    deleted: 0,
    skippedLocked: 0,
    errors: 0,
  };
  for (const dir of params.dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      result.errors++;
      continue;
    }
    const present = new Set(names);
    for (const name of names) {
      if (!TRANSCRIPT_FILE.test(name)) {
        continue;
      }
      const file = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file); // a symlink is not a transcript we own: skipped
      } catch {
        continue; // removed concurrently
      }
      if (!stat.isFile()) {
        continue;
      }
      result.scanned++;
      if (stat.mtimeMs >= cutoff) {
        continue;
      }
      result.expired++;
      // A held session write lock means a run has (or is about to have) this file
      // open. Deleting it then lets the next append recreate a header-less,
      // corrupt transcript (TOCTOU). Skip it; it is swept on a later pass.
      if (present.has(`${name}.lock`) || fs.existsSync(`${file}.lock`)) {
        result.skippedLocked++;
        continue;
      }
      if (settings.mode === "enforce") {
        try {
          fs.unlinkSync(file);
          result.deleted++;
        } catch {
          result.errors++;
        }
      }
    }
  }
  return result;
}

/**
 * A rate-limited runner for the gateway's maintenance tick: runs at most once per
 * `intervalMs` (default hourly), re-reading the config each time so a config
 * change takes effect without a restart.
 */
export function createTranscriptRetentionRunner(opts?: {
  intervalMs?: number;
  loadConfigFn?: () => OpenClawConfig;
  stateDir?: () => string;
  onResult?: (result: TranscriptRetentionResult) => void;
}) {
  const intervalMs = opts?.intervalMs ?? 60 * 60_000;
  const load = opts?.loadConfigFn ?? (() => loadConfig());
  const stateDir = opts?.stateDir ?? (() => resolveStateDir());
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let warnedInvalid = false;
  return {
    maybeRun(now: number = Date.now()): TranscriptRetentionResult | null {
      if (now - lastRunAt < intervalMs) {
        return null;
      }
      lastRunAt = now;
      let config: OpenClawConfig | undefined;
      try {
        config = load();
      } catch {
        config = undefined;
      }
      const settings = resolveTranscriptRetention(config);
      if (!settings) {
        // Configured but unusable must be loud: retention is a go-live precondition.
        if (rawRetention(config) && !warnedInvalid) {
          warnedInvalid = true;
          log.warn(
            "session.maintenance.transcriptRetention is set but invalid (needs maxAge >= 1d); retention is OFF",
          );
        }
        return null;
      }
      warnedInvalid = false;
      const result = sweepSessionTranscripts({
        dirs: resolveSessionDirs(stateDir(), config),
        settings,
        now,
      });
      if (opts?.onResult) {
        opts.onResult(result);
      } else if (result.expired > 0 || result.errors > 0) {
        log.info("session transcript retention", {
          mode: result.mode,
          maxAgeDays: Math.round(result.maxAgeMs / 864e5),
          dirs: result.dirs,
          scanned: result.scanned,
          expired: result.expired,
          deleted: result.deleted,
          skippedLocked: result.skippedLocked,
          errors: result.errors,
        });
      }
      return result;
    },
  };
}
