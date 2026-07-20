/**
 * WhatsApp OUTBOUND transport selection (B-Kapso slice 3b → 3b2).
 *
 * The `whatsapp` channel has one session/identity namespace but can send OUTBOUND
 * over more than one transport: the legacy Baileys web send (default) or a
 * registered alternate (currently Kapso / Meta Cloud API). An extension registers
 * its send via the first-class plugin primitive `api.registerChannelTransport`
 * (channel "whatsapp"); this selector reads the ACTIVE plugin registry — so it
 * inherits registry lifecycle (a plugin unload / config-reload that swaps the
 * registry drops the transport for free) and the global-symbol registry state
 * (survives duplicate module instances). No bespoke module singleton.
 *
 * DORMANT by default: `transport` defaults to `baileys`, so `select` returns null
 * and the caller runs the unchanged Baileys path.
 *
 * FAIL-CLOSED: when a NON-baileys transport is explicitly selected but no matching
 * send is registered, `select` THROWS — the caller must NOT silently fall back to
 * the unguarded Baileys send (which would bypass the opt-out/PHI boundary the
 * operator chose that transport for).
 */

import type { OpenClawConfig } from "../../../config/types.js";
import { getActivePluginRegistry } from "../../../plugins/runtime.js";
import type { ChannelOutboundTransport } from "../types.adapters.js";

const WHATSAPP_CHANNEL = "whatsapp";

/** Raised when a selected non-baileys transport has no registered send (fail-closed). */
export class WhatsAppTransportUnavailableError extends Error {
  constructor(transport: string) {
    super(
      `whatsapp transport "${transport}" is selected but no provider is registered — refusing to fall back to baileys`,
    );
    this.name = "WhatsAppTransportUnavailableError";
  }
}

/**
 * Select the send for the configured transport. Returns null for `baileys` (the
 * default) so the caller runs the unchanged Baileys path. THROWS
 * {@link WhatsAppTransportUnavailableError} when a non-baileys transport is
 * selected but no matching `registerChannelTransport` entry exists in the active
 * plugin registry — fail-closed, never a silent baileys fallback.
 */
export function selectWhatsAppOutboundTransport(
  cfg: OpenClawConfig | undefined,
): ChannelOutboundTransport | null {
  const transport = cfg?.channels?.whatsapp?.transport ?? "baileys";
  if (transport === "baileys") {
    return null;
  }
  const entry = getActivePluginRegistry()?.channelTransports?.find(
    (t) => t.channel === WHATSAPP_CHANNEL && t.transport === transport,
  );
  if (!entry) {
    throw new WhatsAppTransportUnavailableError(transport);
  }
  return entry.send;
}
