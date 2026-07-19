/**
 * WhatsApp OUTBOUND transport selection (B-Kapso slice 3b).
 *
 * The `whatsapp` channel has one session/identity namespace but can send OUTBOUND
 * over more than one transport: the legacy Baileys web send (default) or a
 * registered alternate (currently Kapso / Meta Cloud API). An extension registers
 * its send here at load time; the core outbound adapter selects by the configured
 * `channels.whatsapp.transport` value WITHOUT importing the extension (extensions
 * depend on core, not vice-versa).
 *
 * DORMANT by default: `transport` defaults to `baileys`, so `selectWhatsApp
 * OutboundTransport` returns null and the caller runs the unchanged Baileys path.
 *
 * FAIL-CLOSED (QG): when a NON-baileys transport is explicitly selected but no
 * matching send is registered (extension disabled or its registration failed),
 * `select` THROWS rather than returning null — the caller must NOT silently fall
 * back to the unguarded Baileys send, which would bypass the opt-out/PHI boundary
 * the operator chose that transport for.
 *
 * The registry is stored on a `Symbol.for` global (mirroring src/plugins/runtime.ts)
 * so it survives duplicate module instances (pnpm copies / dist-vs-tsx / ESM-CJS):
 * the extension registers via `openclaw/plugin-sdk` while core selects via the
 * relative import, and both must hit the same Map.
 */

import type { OpenClawConfig } from "../../../config/types.js";
import type { OutboundDeliveryResult } from "../../../infra/outbound/deliver.js";
import type { ChannelOutboundContext } from "../types.adapters.js";

/** An alternate WhatsApp outbound send (same contract as the adapter's sendText). */
export type WhatsAppOutboundTransport = (
  ctx: ChannelOutboundContext,
) => Promise<OutboundDeliveryResult>;

/** Minimal logger seam for collision diagnostics (matches api.logger's shape). */
type TransportLogger = { warn?: (msg: string) => void };

const REGISTRY_KEY = Symbol.for("openclaw.whatsappOutboundTransports");

function registry(): Map<string, WhatsAppOutboundTransport> {
  const g = globalThis as unknown as Record<symbol, Map<string, WhatsAppOutboundTransport>>;
  let map = g[REGISTRY_KEY];
  if (!map) {
    map = new Map();
    g[REGISTRY_KEY] = map;
  }
  return map;
}

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
 * Register an alternate WhatsApp outbound transport by name (e.g. "kapso").
 * Called from an extension's `register()`. Re-registration of a claimed name is
 * allowed (last wins for reload) but WARNED — a collision could silently replace
 * the opt-out-guarded send.
 */
export function registerWhatsAppOutboundTransport(
  name: string,
  send: WhatsAppOutboundTransport,
  logger?: TransportLogger,
): void {
  const map = registry();
  if (map.has(name)) {
    logger?.warn?.(
      `whatsapp transport "${name}" re-registered — the previous provider was replaced (last wins)`,
    );
  }
  map.set(name, send);
}

/**
 * Test/reload hook — clear all registered transports.
 *
 * LIFECYCLE NOTE (slice-4 prerequisite): this registry is NOT yet invalidated on
 * config-reload / plugin-unload, so a disabled/reloaded provider can leave a stale
 * entry (latent while `transport` defaults to `baileys`). Before `transport:
 * "kapso"` goes live (slice 4), either wire this into the gateway reload path
 * (mirroring the registry-identity invalidation in outbound/load.ts) OR migrate
 * to a first-class plugin-registry transport (which inherits lifecycle for free).
 */
export function clearWhatsAppOutboundTransports(): void {
  registry().clear();
}

/**
 * Select the send for the configured transport. Returns null for `baileys` (the
 * default) so the caller runs the unchanged Baileys path. THROWS
 * {@link WhatsAppTransportUnavailableError} when a non-baileys transport is
 * selected but unregistered — fail-closed, never a silent baileys fallback.
 */
export function selectWhatsAppOutboundTransport(
  cfg: OpenClawConfig | undefined,
): WhatsAppOutboundTransport | null {
  const transport = cfg?.channels?.whatsapp?.transport ?? "baileys";
  if (transport === "baileys") {
    return null;
  }
  const send = registry().get(transport);
  if (!send) {
    throw new WhatsAppTransportUnavailableError(transport);
  }
  return send;
}
