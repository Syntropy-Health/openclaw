/**
 * Memory ingestion receipts (A&D: receipt-gated transcript retention, B + C).
 *
 * A receipt says: "the memory store confirmed, by reading it back, that it holds
 * these exact entries". The transcript sweep may purge an entry only when a
 * receipt covers its hash. Receipts hold hashes and store ids ONLY, never
 * content, and are kept after the transcript is purged as audit evidence; the
 * user's `forget` deletes them (CTO #16911 answer 2).
 *
 * Entry identity is CONTENT-ADDRESSED: `entryHash = sha256({role, text})` over
 * the MINIMISED text (what memory actually received). That makes the ledger
 * double as de-duplication: agent_end sees the whole session every turn, and
 * only entries without a receipt are sent again.
 */
import { createHash } from "node:crypto";

export type IngestItem = { role: "user" | "assistant"; text: string };

export type MemoryReceipt = {
  /** Adapter label, e.g. "zep-cloud" or "graphiti-rest". */
  store: string;
  /** Opaque memory scope (never a raw Clerk id). */
  groupId: string;
  /** Ids the STORE assigned, confirmed by read-back. */
  episodeIds: string[];
  /** entryHash for every item the read-back confirmed. */
  entryHashes: string[];
  /** sha256 over the sorted entryHashes — what this receipt covers, exactly. */
  contentHash: string;
  /** When read-back confirmed (not when enqueued). */
  ingestedAt: string;
};

/** Thrown by an adapter when it cannot CONFIRM ingestion. No receipt is issued. */
export class IngestNotConfirmedError extends Error {
  constructor(
    message: string,
    readonly reason: "store_error" | "readback_mismatch" | "readback_timeout",
  ) {
    super(message);
    this.name = "IngestNotConfirmedError";
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The content-addressed id of one (minimised) entry. */
export function entryHash(item: IngestItem): string {
  return sha256(JSON.stringify({ role: item.role, text: item.text }));
}

/** sha256 over the sorted entry hashes. */
export function contentHashOf(entryHashes: string[]): string {
  return sha256([...entryHashes].sort().join("\n"));
}

/** sha256 of a text the store echoed back, for read-back comparison. */
export function textHash(text: string): string {
  return sha256(text);
}

/**
 * Opaque memory group id (CTO #16917 item 4). The store never sees the raw
 * Clerk id: a namespaced sha256, stable so recall and capture agree.
 * (A separate Zep project per app is a later hardening; see the A&D.)
 */
export function opaqueGroupId(rawScope: string): string {
  return `oc_${sha256(`openclaw-memory:v1:${rawScope}`).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface ReceiptLedger {
  /** The subset of `hashes` that already has a receipt in `groupId`. */
  covered(groupId: string, hashes: string[]): Promise<Set<string>>;
  record(receipt: MemoryReceipt): Promise<void>;
  /** Delete every receipt for a group (the user's forget). Returns rows removed. */
  deleteGroup(groupId: string): Promise<number>;
}

type Sql = {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  json?: (v: unknown) => unknown;
};

export async function ensureReceiptSchema(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS lp_memory_receipts (
      id BIGSERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      store TEXT NOT NULL,
      episode_ids JSONB NOT NULL,
      content_hash TEXT NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (group_id, entry_hash)
    )`;
}

export function createPgReceiptLedger(sql: Sql): ReceiptLedger {
  return {
    async covered(groupId, hashes) {
      if (hashes.length === 0) {
        return new Set();
      }
      const rows = await sql<{ entry_hash: string }>`
        SELECT entry_hash FROM lp_memory_receipts
        WHERE group_id = ${groupId} AND entry_hash = ANY(${hashes})`;
      return new Set(rows.map((r) => r.entry_hash));
    },
    async record(r) {
      const episodes = JSON.stringify(r.episodeIds);
      for (const h of r.entryHashes) {
        await sql`
          INSERT INTO lp_memory_receipts
            (group_id, entry_hash, store, episode_ids, content_hash, ingested_at)
          VALUES (${r.groupId}, ${h}, ${r.store}, ${episodes}::jsonb, ${r.contentHash}, ${r.ingestedAt})
          ON CONFLICT (group_id, entry_hash) DO NOTHING`;
      }
    },
    async deleteGroup(groupId) {
      const rows = await sql<{ id: string }>`
        DELETE FROM lp_memory_receipts WHERE group_id = ${groupId} RETURNING id`;
      return rows.length;
    },
  };
}

/** In-memory ledger for tests and for a plugin with no database. */
export function createMemoryReceiptLedger(): ReceiptLedger & { rows: Map<string, MemoryReceipt> } {
  const rows = new Map<string, MemoryReceipt>();
  const key = (g: string, h: string) => `${g}\u0000${h}`;
  return {
    rows,
    async covered(groupId, hashes) {
      return new Set(hashes.filter((h) => rows.has(key(groupId, h))));
    },
    async record(r) {
      for (const h of r.entryHashes) {
        if (!rows.has(key(r.groupId, h))) {
          rows.set(key(r.groupId, h), r);
        }
      }
    },
    async deleteGroup(groupId) {
      let n = 0;
      for (const k of [...rows.keys()]) {
        if (k.startsWith(`${groupId}\u0000`)) {
          rows.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}
