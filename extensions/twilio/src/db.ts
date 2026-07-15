/**
 * Twilio SMS extension pg client (B-Twilio-1, slice 5d).
 *
 * Per ADR 0001 the opt-out store lives in OpenClaw's OWN Postgres — the same
 * `DATABASE_URL` the persist-user-identity plugin uses. This module owns the
 * twilio extension's own small pool to that DB (persist-user-identity keeps its
 * client private, so we can't borrow it); one dedicated pool is the least-
 * coupled option and stays within OpenClaw's DB, never the Journal PHI DB.
 */

import postgres from "postgres";
import { type SqlTag } from "./optout-store.js";

export type SmsPgClient = postgres.Sql;

/** Create the extension's pg pool. Small `max` — opt-out traffic is very light. */
export function createSmsPgClient(databaseUrl: string): SmsPgClient {
  return postgres(databaseUrl, { max: 3 });
}

/** Narrow the pg client to the structural {@link SqlTag} the opt-out store needs. */
export function asSqlTag(client: SmsPgClient): SqlTag {
  return client as unknown as SqlTag;
}
