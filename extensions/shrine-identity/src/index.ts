import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { identityVersion, layerResultFor, listIdentityFiles, loadLayers } from "./identity.js";

/**
 * Sh'rine identity.
 *
 * The core identity is the image-owned agent workspace (agents.defaults.workspace =
 * <shrineDir>/workspace, skipBootstrap = true). This plugin does two things only:
 *  1. At boot, logs `identity=<version>` so a live check can compare it with COSIGN.json.
 *  2. On each turn, adds the platform layer for the caller's channel as a SYSTEM prompt
 *     (layers/<channel>.md). It returns only `systemPrompt`: never tools, model, gate or
 *     permission keys. The channel picks presentation, nothing else.
 * Logs carry the version and the layer id, never prompt or turn content.
 */
const shrineIdentityPlugin = {
  id: "shrine-identity",
  name: "Shrine Identity",
  description: "Sh'rine identity version log and per-platform system-prompt layer",

  register(api: OpenClawPluginApi) {
    const shrineDir = String(api.pluginConfig?.shrineDir ?? "").trim();
    if (!shrineDir) {
      api.logger.error("shrine-identity: shrineDir not configured; no identity layer");
      return;
    }
    if (!fs.existsSync(path.join(shrineDir, "workspace"))) {
      api.logger.error("shrine-identity: workspace missing under shrineDir");
    }
    const version = identityVersion(listIdentityFiles(shrineDir));
    const layers = loadLayers(shrineDir);
    const ids = [...layers.keys()].toSorted().join(",") || "none";
    api.logger.info(`shrine-identity: identity=${version} layers=${ids}`);

    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        const result = layerResultFor(layers, ctx.messageProvider);
        api.logger.info(
          `shrine-identity: identity=${version} layer=${result ? (ctx.messageProvider ?? "").toLowerCase() : "none"}`,
        );
        return result;
      },
      { priority: 100 },
    );
  },
};

export default shrineIdentityPlugin;
