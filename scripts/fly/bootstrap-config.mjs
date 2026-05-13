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
 * `plugins` is source-of-truth in /app.
 */

import fs from "node:fs";
import path from "node:path";

const APP_CONFIG = "/app/openclaw.json";
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

  const dataConfig = readJson(DATA_CONFIG);

  if (appConfig.plugins) {
    dataConfig.plugins = appConfig.plugins;
  }

  fs.writeFileSync(DATA_CONFIG, JSON.stringify(dataConfig, null, 2));
  const allowCount = appConfig.plugins?.allow?.length ?? 0;
  const entriesCount = Object.keys(appConfig.plugins?.entries ?? {}).length;
  log(
    `synced plugins from ${APP_CONFIG} → ${DATA_CONFIG} (allow=${allowCount} entries=${entriesCount})`,
  );
}

main();
