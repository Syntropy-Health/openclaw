/**
 * Per-session binding data shared by every concrete channel adapter (Phase 7).
 *
 * An adapter is constructed PER PAIRED SESSION because "who do I deliver to" is a
 * runtime fact, not a static one: the D0 capability table (channel-capability-config.ts)
 * declares what a channel CAN do, and this type supplies the who. Keeping the two
 * apart is what lets the D0 table stay a static, auditable constant while the
 * destination varies per call/conversation.
 */

/**
 * The destination binding for one paired channel session.
 *
 * `companionE164` exists because of the one genuine per-channel asymmetry the C0
 * seam absorbs: a voice call cannot render a clickable link or a readable OTP
 * code, so those payloads fall back to a paired SMS number. It becomes the
 * adapter's `capabilities.companion_text_channel`, which
 * {@link deliverViaCapabilities} consumes.
 *
 * It is OPTIONAL and only meaningful for voice. When a voice session has no
 * companion bound, a `link`/`otp` delivery FAILS CLOSED (`{ok:false, via:"none"}`,
 * neither sink invoked) rather than silently dropping — never route such a payload
 * anywhere else. For `sms`/`whatsapp` the field is unused: their D0 rows render
 * everything inline, so the companion route is unreachable by construction.
 */
export type AdapterSession = {
  /** The paired peer's E.164 — the destination `deliver()` sends to. */
  toE164: string;
  /**
   * VOICE ONLY: the paired companion SMS number (E.164) that `link`/`otp` fall
   * back to. Absent → voice link/otp fail closed.
   */
  companionE164?: string;
};
