/**
 * Durable SMS opt-out store (B-Twilio-1, slice 5c) — the persistent backing for
 * the slice-4 `OptOutStore` seam.
 *
 * Per ADR 0001: opt-out state lives in OpenClaw's OWN persist-user-identity
 * Postgres (the `DATABASE_URL` the identity plugin already uses), NEVER the
 * Syntropy-Journal PHI database. The table is keyed by the bare E.164 number and
 * is USER-INDEPENDENT so a `STOP` sent before pairing/enrollment is still
 * honored (unlike `lp_user_channels`, whose rows require a paired user_id).
 *
 * Follows the injected-`sql` convention of persist-user-identity/src/db.ts. The
 * schema is created idempotently (`CREATE TABLE IF NOT EXISTS`) — no migration is
 * required to launch. The send-path guard (`guardedSendSms`) is already
 * fail-closed, so an absent/erroring DB suppresses sends rather than leaking them.
 */

import { type OptOutStore } from "./compliance.js";

/**
 * The minimal `postgres`-style tagged-template surface this store needs: call it
 * as a template tag and await an array of rows. The real `postgres.Sql`
 * (persist-user-identity's `createPgClient`) satisfies this structurally, so the
 * twilio extension needs no direct `postgres` dependency and stays decoupled
 * from the driver.
 */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** Idempotent DDL for the opt-out table. Safe to call on every startup. */
export async function ensureOptOutSchema(sql: SqlTag): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS lp_sms_optouts (
      channel_peer_id VARCHAR(512) PRIMARY KEY,
      opted_out_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

/**
 * A durable {@link OptOutStore} backed by `lp_sms_optouts`. STOP inserts (idempotent
 * via ON CONFLICT), START deletes, the send-check selects. Keyed by E.164 only.
 */
export function createPgOptOutStore(sql: SqlTag): OptOutStore {
  return {
    isOptedOut: async (e164) => {
      const rows = await sql`
        SELECT 1 FROM lp_sms_optouts WHERE channel_peer_id = ${e164} LIMIT 1
      `;
      return rows.length > 0;
    },
    optOut: async (e164) => {
      await sql`
        INSERT INTO lp_sms_optouts (channel_peer_id) VALUES (${e164})
        ON CONFLICT (channel_peer_id) DO NOTHING
      `;
    },
    optIn: async (e164) => {
      await sql`DELETE FROM lp_sms_optouts WHERE channel_peer_id = ${e164}`;
    },
  };
}
