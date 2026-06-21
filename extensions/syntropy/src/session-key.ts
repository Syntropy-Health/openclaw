/**
 * Session-key parsing for the Syntropy extension.
 *
 * Re-exported from the shared canonical module so the parsing convention stays
 * identical across persist-user-identity, auth-memory-gate, and syntropy — the
 * three hooks that resolve identity from the same session key (oc-hygiene #7).
 * See `extensions/shared/session-key.ts` for the format documentation.
 */

export { deriveChannel, derivePeerId } from "../../shared/session-key.js";
