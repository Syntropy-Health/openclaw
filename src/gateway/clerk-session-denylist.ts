/**
 * Clerk session deny-list (G-lane [G2b], A&D §7 must-fix #2).
 *
 * Problem: after a mobile sign-out unbinds the device link, a REPLAYED (captured
 * or in-flight) Clerk JWT from the signed-out session still crypto-verifies for
 * up to its TTL — and a verified turn would re-run the [G1] auto-bind, silently
 * re-linking the device. Honest sign-out already discards the token client-side;
 * this list closes the replay window for IMMEDIATE consent-kill (not TTL-delayed).
 *
 * On unbind the gateway denies the JWT's `sid` (Clerk session id) until
 * now + DENY_TTL; the CHAT auth path rejects any JWT whose sid is denied → 401,
 * no agent turn, no re-bind. The UNBIND endpoint itself does NOT consult the
 * list — "unbind twice → 200 both" (idempotency pin, A&D §7 test (c)).
 *
 * Entries self-expire (DENY_TTL comfortably exceeds any real token TTL — mobile
 * tokens are ~60s), and the map is FIFO-capped so memory stays flat.
 */

const DEFAULT_DENY_TTL_MS = 15 * 60 * 1000; // ≥ any sane Clerk token TTL (~60s)
const MAX_ENTRIES = 10_000;

/**
 * The store lives on a `Symbol.for` GLOBAL (the plugins/runtime.ts pattern):
 * the WRITER (the signout route, loaded as an extension via jiti) and the
 * READER (the gateway auth path, bundled) may resolve this module as two
 * separate instances — a plain module-level Map would then split into two
 * stores and revocation would silently no-op. `Symbol.for` keys one shared
 * Map per PROCESS regardless of module identity.
 *
 * ⚠️ HA caveat (per security review): the list is PROCESS-local — with >1
 * gateway replica, a sign-out on one instance does not revoke on the others
 * (the replay window then falls back to the token's own ~60s TTL). Current
 * deploy is single-instance; a shared store (pg/redis) is the follow-up if
 * the gateway ever scales horizontally. Documented in the A&D ops notes.
 */
const DENYLIST_KEY = Symbol.for("openclaw.clerkSessionDenylist");

function store(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number>>;
  let map = g[DENYLIST_KEY];
  if (!map) {
    map = new Map();
    g[DENYLIST_KEY] = map;
  }
  return map;
}

function sweep(denied: Map<string, number>, now: number): void {
  for (const [sid, expiresAt] of denied) {
    if (expiresAt <= now) {
      denied.delete(sid);
    }
  }
  // FIFO cap backstop (insertion order): keeps memory flat under abuse.
  while (denied.size > MAX_ENTRIES) {
    const oldest = denied.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    denied.delete(oldest);
  }
}

/** Deny a Clerk session id until now + ttlMs (default 15 min). No-op on empty sid. */
export function denyClerkSession(sid: string, ttlMs: number = DEFAULT_DENY_TTL_MS): void {
  const trimmed = sid.trim();
  if (!trimmed) {
    return;
  }
  const denied = store();
  const now = Date.now();
  sweep(denied, now);
  denied.set(trimmed, now + ttlMs);
}

/** Whether a sid is currently denied. Undefined/absent sid → not denied. */
export function isClerkSessionDenied(sid: string | undefined): boolean {
  // Trim symmetrically with denyClerkSession so write/read keys always match.
  const trimmed = sid?.trim();
  if (!trimmed) {
    return false;
  }
  const denied = store();
  const expiresAt = denied.get(trimmed);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    denied.delete(trimmed);
    return false;
  }
  return true;
}

/** Test hook — clear all entries. */
export function clearClerkSessionDenylist(): void {
  store().clear();
}
