/**
 * SMS first-contact record — backs mobile-originated opt-in.
 *
 * The registered ShrineAI campaign treats a number's FIRST message as its opt-in and
 * confirms it with OPT_IN_REPLY (compliance.ts). To send that confirmation exactly
 * once we need a durable "have we confirmed this number" record, keyed by bare E.164
 * and user-independent (same reasoning as lp_sms_optouts: it must work before
 * pairing). Lives in OpenClaw's own Postgres, never the Journal PHI database (ADR 0001).
 */
import { type SqlTag } from "./optout-store.js";

export interface SmsContactStore {
  /** Record `e164` as confirmed. Resolves true iff this call created the record,
   * i.e. the number had never been confirmed before. */
  recordFirstContact: (e164: string) => Promise<boolean> | boolean;
}

/** Idempotent DDL. Safe to call on every startup. */
export async function ensureContactSchema(sql: SqlTag): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS lp_sms_contacts (
      channel_peer_id VARCHAR(512) PRIMARY KEY,
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

/** Atomic first-contact check: the INSERT either creates the row (first) or does
 * nothing (seen), so two concurrent first messages confirm once, not twice. */
export function createPgContactStore(sql: SqlTag): SmsContactStore {
  return {
    recordFirstContact: async (e164) => {
      const rows = await sql`
        INSERT INTO lp_sms_contacts (channel_peer_id) VALUES (${e164})
        ON CONFLICT (channel_peer_id) DO NOTHING
        RETURNING channel_peer_id
      `;
      return rows.length > 0;
    },
  };
}
