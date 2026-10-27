import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";

/**
 * Derive the server-side L1 `user_scope` from a verified Clerk `sub`.
 *
 * This is the gateway-layer view of the settled shared resolver
 * `deriveScopeKey({ external_id, id }) = external_id ?? id` (extensions/shared/
 * scope-key.ts, #836). For a Clerk-verified chat request the `external_id` IS
 * the JWT `sub` and is always present, so the scope is exactly `sub`. It is
 * inlined here (rather than imported from the extensions layer) to avoid a
 * src → extensions layering inversion; the contract is identical by
 * construction and documented in both places.
 */
export function deriveUserScopeFromSub(sub: string | undefined): string | undefined {
  const externalId = sub?.trim();
  return externalId || undefined;
}

export function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

export function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = raw.slice(7).trim();
  return token || undefined;
}

export function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    getHeader(req, "x-openclaw-agent-id")?.trim() ||
    getHeader(req, "x-openclaw-agent")?.trim() ||
    "";
  if (!raw) {
    return undefined;
  }
  return normalizeAgentId(raw);
}

/**
 * Default allowlist for the presentation-only `x-openclaw-channel` header.
 *
 * The header influences ONLY the downstream `messageChannel` (delivery/markdown
 * presentation via MARKDOWN_CAPABLE_CHANNELS). It must NEVER let an arbitrary
 * client string flow into `messageChannel`, so it is a strict allowlist and an
 * unknown/absent value resolves to `undefined` (the caller then defaults to the
 * behavior-preserving `"webchat"`).
 */
const DEFAULT_CHANNEL_ALLOWLIST: readonly string[] = ["webchat", "shrinemobile"];

/**
 * Resolve the presentation-only channel from the `x-openclaw-channel` request
 * header. Trims and lowercases the value and returns it ONLY when it is in the
 * allowlist; otherwise (unknown, absent, or empty) returns `undefined` so the
 * caller can default to `"webchat"`. Never throws.
 *
 * INVARIANT (A&D §S10): this value feeds ONLY `messageChannel` — it must not
 * influence auth, externalId, userScope, or sessionKey derivation.
 */
export function resolveChannelFromHeader(
  req: IncomingMessage,
  opts?: { allowlist?: string[] },
): string | undefined {
  const raw = getHeader(req, "x-openclaw-channel")?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  const allowlist = opts?.allowlist ?? DEFAULT_CHANNEL_ALLOWLIST;
  return allowlist.includes(raw) ? raw : undefined;
}

export function resolveAgentIdFromModel(model: string | undefined): string | undefined {
  const raw = model?.trim();
  if (!raw) {
    return undefined;
  }

  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  const agentId = m?.groups?.agentId;
  if (!agentId) {
    return undefined;
  }
  return normalizeAgentId(agentId);
}

export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) {
    return fromHeader;
  }

  const fromModel = resolveAgentIdFromModel(params.model);
  return fromModel ?? "main";
}

/** One opaque, structure-free session-key segment for a client-supplied hint. */
function hashSessionHint(hint: string): string {
  // Lowercased first: the raw key was lowercased downstream (normalizeMainKey),
  // so `Thread-42` and `thread-42` were one session; keep it that way.
  return `h${createHash("sha256").update(hint.toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** Which session-key structural tokens a client hint carried (flags only). */
export type StructuralHintFlags = { direct: boolean; colon: boolean; main: boolean };

/**
 * Detect a hint that tries to inject session-key structure: a `:`, or a
 * `:`-separated segment equal to `direct` / `main` (case-insensitive). Returns
 * null for an ordinary hint.
 */
export function detectStructuralHint(hint: string): StructuralHintFlags | null {
  const segments = new Set(hint.split(":").map((s) => s.trim().toLowerCase()));
  const flags = {
    direct: segments.has("direct"),
    colon: hint.includes(":"),
    main: segments.has("main"),
  };
  return flags.direct || flags.colon || flags.main ? flags : null;
}

/**
 * A rate-limited warn for structural-hint ATTEMPTS: at most one line per
 * `intervalMs` (default 10 s); the next emitted line carries `suppressed=<n>`.
 * The line holds the three flags ONLY — never the hint, the sub, or any part
 * of either.
 */
export function createStructuralHintReporter(
  warn: (message: string) => void,
  intervalMs = 10_000,
): (flags: StructuralHintFlags) => void {
  let lastAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return (flags) => {
    const now = Date.now();
    if (now - lastAt < intervalMs) {
      suppressed += 1;
      return;
    }
    lastAt = now;
    const tail = suppressed > 0 ? ` suppressed=${suppressed}` : "";
    suppressed = 0;
    warn(
      `openresponses: session hint carried structural tokens (direct=${flags.direct} colon=${flags.colon} main=${flags.main})${tail}`,
    );
  };
}

export function resolveSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
  /**
   * Server-derived L1 user_scope (= deriveScopeKey({external_id: sub, id: sub})
   * = the verified Clerk `sub`). When present it OVERRIDES any client-supplied
   * `user` and forces the session into the user's partition — even when the
   * client sends an `X-OpenClaw-Session-Key` (which is then threaded as an L3
   * conversation hint WITHIN that partition, never as the identity). This is the
   * unification guarantee: one Clerk user → one user_scope across consumers.
   */
  userScope?: string | undefined;
  prefix: string;
  /**
   * Called (flags only) when a VERIFIED caller's hint carried session-key
   * structure — an attempt signal. Wire a rate-limited reporter
   * ({@link createStructuralHintReporter}); never log the hint itself.
   */
  onStructuralHint?: (flags: StructuralHintFlags) => void;
}): string {
  const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
  const scope = params.userScope?.trim();

  if (scope) {
    // L1 user_scope is authoritative. Thread the L3 session hint (if any) as a
    // suffix so turns within one conversation share a key but stay inside the
    // user's partition; the client-supplied `user` field is ignored (§5).
    //
    // The hint is CLIENT-CONTROLLED, so it is neutralised into ONE opaque
    // segment (`h` + 16 hex of sha256). Threaded raw, a hint such as
    // `direct:<victim>` made derivePeerId return `<victim>`, and the identity
    // hooks then resolved the victim's identity/token for a verified caller.
    // Same hint → same segment, so conversation continuity is preserved.
    if (explicit && params.onStructuralHint) {
      const flags = detectStructuralHint(explicit);
      if (flags) {
        params.onStructuralHint(flags);
      }
    }
    const sessionHint = explicit ? `:${hashSessionHint(explicit)}` : "";
    const mainKey = `${params.prefix}-user:${scope}${sessionHint}`;
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
  }

  // Legacy (non-Clerk) path — unchanged.
  if (explicit) {
    return explicit;
  }

  const user = params.user?.trim();
  const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}
