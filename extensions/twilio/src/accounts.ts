/**
 * SMS channel account model (B-Twilio-1, slice 5a) — bridges the live
 * OpenClawConfig to the credential-complete `ResolvedTwilioSmsConfig`.
 *
 * Config lives at `cfg.channels.sms` (ChannelsConfig has an index signature, so
 * a plugin channel needs no core config-type change) and falls back to the
 * `TWILIO_*` env vars via {@link resolveTwilioSmsConfig}. v1 is a single-account
 * channel (one subaccount / one sender number). The channel stays INERT until
 * credential-complete — matching the fail-closed "no partial wiring" posture.
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ChannelConfigAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  resolveTwilioSmsConfig,
  TwilioSmsConfigSchema,
  type ResolvedTwilioSmsConfig,
} from "./config.js";

/** The channel id for SMS (vendor-agnostic; Twilio is only the transport). */
export const SMS_CHANNEL_ID = "sms";

export type ResolvedSmsAccount = {
  accountId: string;
  /** Credential-complete config, or null when the channel is inert. */
  config: ResolvedTwilioSmsConfig | null;
  configured: boolean;
};

/** Raw config object stored at `cfg.channels.sms` (untyped plugin-channel slot). */
function readRawSmsConfig(cfg: OpenClawConfig): unknown {
  return (cfg.channels as Record<string, unknown> | undefined)?.[SMS_CHANNEL_ID];
}

/**
 * Resolve the single SMS account from config + env. A malformed config object is
 * ignored (falls back to env) rather than throwing — a bad config section must
 * not crash channel resolution; it just leaves the channel inert.
 */
export function resolveSmsAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSmsAccount {
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const raw = readRawSmsConfig(cfg);
  const parsed = raw ? TwilioSmsConfigSchema.safeParse(raw) : null;
  const input = parsed?.success ? parsed.data : undefined;
  const config = resolveTwilioSmsConfig(input, env);
  return { accountId: id, config, configured: config !== null };
}

/** v1 single-account channel: always exposes the default account. */
export function listSmsAccountIds(_cfg: OpenClawConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

/** The `ChannelConfigAdapter` for the SMS channel (consumed by the plugin, slice 5d). */
export const smsConfigAdapter: ChannelConfigAdapter<ResolvedSmsAccount> = {
  listAccountIds: (cfg) => listSmsAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveSmsAccount(cfg, accountId),
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  isConfigured: (account) => account.configured,
};
