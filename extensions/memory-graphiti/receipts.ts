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
import { createHash, createHmac } from "node:crypto";

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

/** What the store accepted, before it is confirmed: Zep episode uuid, or the REST batch marker. */
export type Submission = { ref: string };

/** Result of checking a submission: confirmed (receipt-able) or still processing. */
export type ConfirmResult = { status: "confirmed"; episodeIds: string[] } | { status: "pending" };

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
export function opaqueGroupId(rawScope: string, pepper?: string): string {
  if (pepper) {
    // Keyed: a party that knows the raw Clerk ids (e.g. the store, which may hold
    // other data keyed by them) still cannot link the group back without the pepper.
    return `ok_${createHmac("sha256", pepper).update(`openclaw-memory:v1:${rawScope}`).digest("hex").slice(0, 32)}`;
  }
  // Unkeyed: hides the raw id from casual view, but is LINKABLE by anyone holding raw ids.
  return `oc_${sha256(`openclaw-memory:v1:${rawScope}`).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface ReceiptLedger {
  /** The subset of `hashes` that already has a receipt in `groupId`. */
  covered(groupId: string, hashes: string[]): Promise<Set<string>>;
  record(receipt: MemoryReceipt): Promise<void>;
  /**
   * Sent but not yet confirmed: hash → the store's submission ref. Persisted
   * BEFORE read-back, so a failed or slow confirmation is re-CHECKED next time,
   * never re-SENT (no duplicate episodes at the store).
   */
  pending(groupId: string, hashes: string[]): Promise<Map<string, string>>;
  addPending(groupId: string, hashes: string[], ref: string, store: string): Promise<void>;
  clearPending(groupId: string, hashes: string[]): Promise<void>;
  /**
   * Entries the user asked to FORGET (hashes only). Capture never sends them again,
   * even though the gateway's live session may still replay them (agent_end sees the
   * whole session). Kept after the forget, deliberately: deleting them would let the
   * next turn re-upload exactly what was cleared.
   */
  tombstoned(groupId: string, hashes: string[]): Promise<Set<string>>;
  addTombstones(groupId: string, hashes: string[]): Promise<void>;
  /** Delete every receipt AND pending row for a group (the user's forget). Returns receipts removed. */
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
  await sql`
    CREATE TABLE IF NOT EXISTS lp_memory_pending (
      group_id TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      ref TEXT NOT NULL,
      store TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, entry_hash)
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS lp_memory_tombstones (
      group_id TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, entry_hash)
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
    async pending(groupId, hashes) {
      if (hashes.length === 0) {
        return new Map();
      }
      const rows = await sql<{ entry_hash: string; ref: string }>`
        SELECT entry_hash, ref FROM lp_memory_pending
        WHERE group_id = ${groupId} AND entry_hash = ANY(${hashes})`;
      return new Map(rows.map((r) => [r.entry_hash, r.ref]));
    },
    async addPending(groupId, hashes, ref, store) {
      for (const h of hashes) {
        await sql`
          INSERT INTO lp_memory_pending (group_id, entry_hash, ref, store)
          VALUES (${groupId}, ${h}, ${ref}, ${store})
          ON CONFLICT (group_id, entry_hash) DO NOTHING`;
      }
    },
    async clearPending(groupId, hashes) {
      if (hashes.length > 0) {
        await sql`
          DELETE FROM lp_memory_pending WHERE group_id = ${groupId} AND entry_hash = ANY(${hashes})`;
      }
    },
    async tombstoned(groupId, hashes) {
      if (hashes.length === 0) {
        return new Set();
      }
      const rows = await sql<{ entry_hash: string }>`
        SELECT entry_hash FROM lp_memory_tombstones
        WHERE group_id = ${groupId} AND entry_hash = ANY(${hashes})`;
      return new Set(rows.map((r) => r.entry_hash));
    },
    async addTombstones(groupId, hashes) {
      for (const h of hashes) {
        await sql`
          INSERT INTO lp_memory_tombstones (group_id, entry_hash)
          VALUES (${groupId}, ${h})
          ON CONFLICT (group_id, entry_hash) DO NOTHING`;
      }
    },
    async deleteGroup(groupId) {
      await sql`DELETE FROM lp_memory_pending WHERE group_id = ${groupId}`;
      const rows = await sql<{ id: string }>`
        DELETE FROM lp_memory_receipts WHERE group_id = ${groupId} RETURNING id`;
      return rows.length;
    },
  };
}

/** In-memory ledger for tests and for a plugin with no database. */
export function createMemoryReceiptLedger(): ReceiptLedger & {
  rows: Map<string, MemoryReceipt>;
  pend: Map<string, string>;
  tombs: Set<string>;
} {
  const rows = new Map<string, MemoryReceipt>();
  const pend = new Map<string, string>();
  const tombs = new Set<string>();
  const key = (g: string, h: string) => `${g}\u0000${h}`;
  return {
    rows,
    pend,
    tombs,
    async tombstoned(groupId, hashes) {
      return new Set(hashes.filter((h) => tombs.has(key(groupId, h))));
    },
    async addTombstones(groupId, hashes) {
      for (const h of hashes) {
        tombs.add(key(groupId, h));
      }
    },
    async pending(groupId, hashes) {
      const out = new Map<string, string>();
      for (const h of hashes) {
        const ref = pend.get(key(groupId, h));
        if (ref !== undefined) {
          out.set(h, ref);
        }
      }
      return out;
    },
    async addPending(groupId, hashes, ref) {
      for (const h of hashes) {
        if (!pend.has(key(groupId, h))) {
          pend.set(key(groupId, h), ref);
        }
      }
    },
    async clearPending(groupId, hashes) {
      for (const h of hashes) {
        pend.delete(key(groupId, h));
      }
    },
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
      for (const k of [...pend.keys()]) {
        if (k.startsWith(`${groupId}\u0000`)) {
          pend.delete(k);
        }
      }
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
