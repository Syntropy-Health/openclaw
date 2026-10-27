#!/usr/bin/env node
/**
 * Bootstrap /data/openclaw.json with the source-of-truth plugins/channels
 * config from /app/openclaw.json on every Fly boot.
 *
 * Why: openclaw resolves config from `$OPENCLAW_STATE_DIR/openclaw.json`
 * first (src/config/paths.ts:151-180). On Fly we set OPENCLAW_STATE_DIR=/data
 * to persist gateway runtime state (tokens, sessions). But the committed
 * /app/openclaw.json — which declares plugins.allow + plugins.entries — is
 * then ignored. Result: bundled plugins fall back to default-disabled and
 * syntropy (and others) never load. See monorepo#74.
 *
 * Strategy: at boot, REPLACE the `plugins` key on /data with /app's value,
 * leaving runtime-managed keys (gateway.auth.token, talk.apiKey, agents.*)
 * intact. If /data is empty (first boot), seed the file by copying /app
 * verbatim.
 *
 * The `channels` key is intentionally NOT overwritten because /app's
 * `channels.whatsapp.enabled` was rejected by the runtime config schema
 * (see merge-attempt incident 2026-05-13). Channels stay in /data; only
 * `plugins` is source-of-truth in /app, plus
 * `session.maintenance.transcriptRetention` (mono #544) and
 * `agents.defaults.{workspace,skipBootstrap}` (openclaw-shrineai-identity), plus
 * `gateway.http.endpoints.responses.images` (per-request image caps).
 */

import fs from "node:fs";
import path from "node:path";

// Overridable for tests only; the image always uses /app/openclaw.json.
const APP_CONFIG = process.env.OPENCLAW_APP_CONFIG_PATH || "/app/openclaw.json";
const DATA_CONFIG = process.env.OPENCLAW_CONFIG_PATH ?? "/data/openclaw.json";

function log(msg) {
  process.stdout.write(`[bootstrap-config] ${msg}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function main() {
  if (!fs.existsSync(APP_CONFIG)) {
    log(`source ${APP_CONFIG} missing — nothing to do`);
    return;
  }

  const appConfig = readJson(APP_CONFIG);
  const dataDir = path.dirname(DATA_CONFIG);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(DATA_CONFIG)) {
    fs.writeFileSync(DATA_CONFIG, JSON.stringify(appConfig, null, 2));
    log(`seeded ${DATA_CONFIG} from ${APP_CONFIG} (first boot)`);
    return;
  }

  let dataConfig;
  let dataRaw;
  try {
    dataRaw = fs.readFileSync(DATA_CONFIG, "utf8");
    dataConfig = JSON.parse(dataRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`WARN: ${DATA_CONFIG} unreadable/corrupt (${msg}) — reseeding from ${APP_CONFIG}`);
    fs.writeFileSync(DATA_CONFIG, JSON.stringify(appConfig, null, 2));
    log(`seeded ${DATA_CONFIG} from ${APP_CONFIG} (recovery)`);
    return;
  }

  if (appConfig.plugins) {
    dataConfig.plugins = appConfig.plugins;
  }
  // session.maintenance.transcriptRetention is image-owned too (mono #544): it is a
  // go-live precondition and must not depend on hand-editing the volume. ONLY that
  // key is synced, so operator edits to the rest of session.maintenance (pruneAfter,
  // maxEntries, rotateBytes, core mode) and of `session` survive. Changing it (e.g.
  // flipping to "enforce") is an image change + redeploy, not a /data edit.
  const retention = appConfig.session?.maintenance?.transcriptRetention;
  if (retention) {
    dataConfig.session = {
      ...dataConfig.session,
      maintenance: { ...dataConfig.session?.maintenance, transcriptRetention: retention },
    };
  }

  // The agent identity is image-owned too (openclaw-shrineai-identity R2): the default
  // agent's workspace points at the image's read-only identity dir, and first-run
  // bootstrap is off, so no redeploy or fresh volume can bring the generic persona back.
  // ONLY these two agents.defaults keys are synced; the model and the rest of agents.*
  // stay operator-owned on /data.
  const appDefaults = appConfig.agents?.defaults ?? {};
  const identityKeys = {};
  for (const key of ["workspace", "skipBootstrap"]) {
    if (appDefaults[key] !== undefined) {
      identityKeys[key] = appDefaults[key];
    }
  }
  // The image workspace is read-only, so the pre-compaction memory flush (which writes
  // memory/*.md into the workspace) is image-owned too: ONLY its `enabled` flag is synced.
  const flushEnabled = appDefaults.compaction?.memoryFlush?.enabled;
  if (Object.keys(identityKeys).length > 0 || flushEnabled !== undefined) {
    const defaults = { ...dataConfig.agents?.defaults, ...identityKeys };
    if (flushEnabled !== undefined) {
      defaults.compaction = {
        ...defaults.compaction,
        memoryFlush: { ...defaults.compaction?.memoryFlush, enabled: flushEnabled },
      };
    }
    dataConfig.agents = { ...dataConfig.agents, defaults };
  }

  // The /v1/responses image caps (maxBytes, maxCount, ...) are image-owned too: ONLY
  // gateway.http.endpoints.responses.images is synced, and it is MERGED per key, so an
  // operator's /data allowUrl/urlAllowlist survive and the rest of /data's gateway block
  // (auth, mode, other endpoints, other responses keys) stays operator-owned.
  const responsesImages = appConfig.gateway?.http?.endpoints?.responses?.images;
  if (responsesImages) {
    const gateway = dataConfig.gateway ?? {};
    const http = gateway.http ?? {};
    const endpoints = http.endpoints ?? {};
    dataConfig.gateway = {
      ...gateway,
      http: {
        ...http,
        endpoints: {
          ...endpoints,
          responses: {
            ...endpoints.responses,
            images: { ...endpoints.responses?.images, ...responsesImages },
          },
        },
      },
    };
  }

  // Write only when the content changes: an unchanged config keeps its bytes and
  // mtime, so a reboot is idempotent (CTO #13223).
  const next = JSON.stringify(dataConfig, null, 2);
  if (dataRaw === next) {
    log(`plugins already in sync with ${APP_CONFIG}; ${DATA_CONFIG} unchanged`);
    return;
  }
  fs.writeFileSync(DATA_CONFIG, next);
  const allowCount = appConfig.plugins?.allow?.length ?? 0;
  const entriesCount = Object.keys(appConfig.plugins?.entries ?? {}).length;
  log(
    `synced plugins from ${APP_CONFIG} → ${DATA_CONFIG} (allow=${allowCount} entries=${entriesCount})`,
  );
}

main();
