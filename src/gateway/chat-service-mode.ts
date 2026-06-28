import type { OpenClawConfig } from "../config/config.js";
import { parseBooleanValue } from "../utils/boolean.js";

/**
 * The env primitive that toggles channels on/off for a gateway instance.
 * Highest-priority knob; overrides `gateway.runMode`.
 */
export const CHANNELS_ENABLED_ENV_KEY = "OPENCLAW_CHANNELS_ENABLED";

export type ChatServiceModeOverrides = {
  /** Whether any channel (WhatsApp/Baileys/etc.) starts. */
  channelsEnabled: boolean;
  /**
   * Suggested controlUiEnabled default for this run-shape (only applied when
   * the caller has no explicit override). chat-service mode ⇒ false.
   */
  controlUiEnabledDefault?: boolean;
  /**
   * Suggested openResponsesEnabled default for this run-shape (only applied
   * when the caller has no explicit override). chat-service mode ⇒ true.
   */
  openResponsesEnabledDefault?: boolean;
};

/**
 * Resolve the chat-service run-mode overrides from config + env.
 *
 * Precedence for `channelsEnabled`:
 *   1. `OPENCLAW_CHANNELS_ENABLED` env (true/false) — the primitive knob.
 *   2. `gateway.runMode === "chat-service"` ⇒ channels off.
 *   3. default ⇒ channels on (byte-identical to the full gateway).
 *
 * When the resolved shape is chat-service (channels off), the design note's
 * companion defaults ride along: controlUiEnabled=false, openResponsesEnabled=true.
 * These are *defaults* — the caller should only apply them when it has no
 * explicit config/CLI override for those flags, keeping `channelsEnabled` the
 * single real primitive.
 */
export function resolveChatServiceMode(params: {
  cfg: Pick<OpenClawConfig, "gateway">;
  env: NodeJS.ProcessEnv;
}): ChatServiceModeOverrides {
  const { cfg, env } = params;
  const envOverride = parseBooleanValue(env[CHANNELS_ENABLED_ENV_KEY]);
  const isChatServiceRunMode = cfg.gateway?.runMode === "chat-service";

  const channelsEnabled = envOverride !== undefined ? envOverride : !isChatServiceRunMode;

  // The companion defaults apply whenever the effective shape is channels-off,
  // whether that came from the env primitive or the runMode config.
  if (!channelsEnabled) {
    return {
      channelsEnabled,
      controlUiEnabledDefault: false,
      openResponsesEnabledDefault: true,
    };
  }
  return { channelsEnabled };
}
