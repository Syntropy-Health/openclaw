/**
 * Session-transcript retention (mono #544, SMS go-live precondition).
 *
 * Why this exists: core session maintenance prunes `sessions.json` ENTRIES and
 * only RENAMES their transcripts to `<file>.deleted.<ts>`, so transcript content
 * stays on disk forever. It also never sees transcripts that are not indexed
 * (measured on staging 2026-10-18: 30 of 46 transcripts unindexed, 33 older than
 * 30 days). This sweep works on the FILES: every transcript (`*.jsonl`) and every
 * archived transcript (`*.jsonl.deleted.*`, `*.jsonl.reset.*`) under
 * `<stateDir>/agents/<agent>/sessions` whose mtime is older than `maxAge`.
 *
 * Opt-in: with `session.maintenance.transcriptRetention` absent, nothing runs.
 * `mode: "warn"` (the default) only counts; `mode: "enforce"` deletes.
 * Logs carry counts only, never file names or contents.
 */
import fs from "node:fs";
import path from "node:path";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig } from "../config.js";
import { resolveStateDir } from "../paths.js";

const log = createSubsystemLogger("sessions/retention");

/** A live or archived transcript. `sessions.json` and anything else is never touched. */
const TRANSCRIPT_FILE = /\.jsonl(\.(deleted|reset)\.[^/\\]+)?$/;

export type TranscriptRetentionMode = "warn" | "enforce";

export type TranscriptRetentionSettings = {
  maxAgeMs: number;
  mode: TranscriptRetentionMode;
};

export type TranscriptRetentionResult = TranscriptRetentionSettings & {
  scanned: number;
  expired: number;
  deleted: number;
  errors: number;
};

/** Settings from openclaw.json, or null when retention is not configured (no sweep). */
export function resolveTranscriptRetention(
  config: { session?: { maintenance?: { transcriptRetention?: unknown } } } | undefined,
): TranscriptRetentionSettings | null {
  const raw = config?.session?.maintenance?.transcriptRetention as
    | { maxAge?: string | number; mode?: TranscriptRetentionMode }
    | undefined;
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
  if (!(maxAgeMs > 0)) {
    return null;
  }
  return { maxAgeMs, mode: raw.mode === "enforce" ? "enforce" : "warn" };
}

function sessionDirs(stateDir: string): string[] {
  const agentsRoot = path.join(stateDir, "agents");
  let agents: string[];
  try {
    agents = fs.readdirSync(agentsRoot);
  } catch {
    return [];
  }
  return agents
    .map((a) => path.join(agentsRoot, a, "sessions"))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

/** One pass over every agent's sessions dir. */
export function sweepSessionTranscripts(params: {
  stateDir: string;
  settings: TranscriptRetentionSettings;
  now?: number;
}): TranscriptRetentionResult {
  const { stateDir, settings } = params;
  const cutoff = (params.now ?? Date.now()) - settings.maxAgeMs;
  const result: TranscriptRetentionResult = {
    ...settings,
    scanned: 0,
    expired: 0,
    deleted: 0,
    errors: 0,
  };
  for (const dir of sessionDirs(stateDir)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      result.errors++;
      continue;
    }
    for (const name of names) {
      if (!TRANSCRIPT_FILE.test(name)) {
        continue;
      }
      const file = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
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
  resolveSettings?: () => TranscriptRetentionSettings | null;
  stateDir?: () => string;
  onResult?: (result: TranscriptRetentionResult) => void;
}) {
  const intervalMs = opts?.intervalMs ?? 60 * 60_000;
  const resolveSettings =
    opts?.resolveSettings ??
    (() => {
      try {
        return resolveTranscriptRetention(loadConfig());
      } catch {
        return null;
      }
    });
  const stateDir = opts?.stateDir ?? (() => resolveStateDir());
  let lastRunAt = Number.NEGATIVE_INFINITY;
  return {
    maybeRun(now: number = Date.now()): TranscriptRetentionResult | null {
      if (now - lastRunAt < intervalMs) {
        return null;
      }
      lastRunAt = now;
      const settings = resolveSettings();
      if (!settings) {
        return null;
      }
      const result = sweepSessionTranscripts({ stateDir: stateDir(), settings, now });
      if (opts?.onResult) {
        opts.onResult(result);
      } else if (result.expired > 0 || result.errors > 0) {
        log.info("session transcript retention", {
          mode: result.mode,
          maxAgeDays: Math.round(result.maxAgeMs / 864e5),
          scanned: result.scanned,
          expired: result.expired,
          deleted: result.deleted,
          errors: result.errors,
        });
      }
      return result;
    },
  };
}
