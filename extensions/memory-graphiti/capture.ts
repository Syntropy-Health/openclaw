/**
 * Capture with receipts (A&D B + C). Replaces the fire-and-forget addMessages.
 *
 * 1. Minimise every message (identity and context blocks stripped; a message
 *    that cannot be made safe is dropped, never sent).
 * 2. Skip entries that already have a receipt. agent_end carries the WHOLE
 *    session every turn, so this is also de-duplication.
 * 3. Entries already SENT but not yet confirmed are re-CHECKED by read-back,
 *    never re-sent (no duplicate episodes at the store).
 * 4. New entries are sent in size-capped batches, recorded as pending BEFORE
 *    read-back, then checked once.
 * 5. Confirmed ⇒ receipt recorded and pending cleared. Not confirmed ⇒ no
 *    receipt, so the transcript sweep holds that content.
 */
import { batchText, buildReceipt, type MemoryClient } from "./client.js";
import { minimiseForMemory } from "./minimise.js";
import {
  entryHash,
  IngestNotConfirmedError,
  type IngestItem,
  type ReceiptLedger,
} from "./receipts.js";

export type ExtractedMessage = { content: string; roleType: "user" | "assistant" };

/** Max characters per batch sent to the store (Zep caps an episode's data; INFERRED ~10k). */
export const MAX_BATCH_CHARS = 8_000;

export type CaptureResult = {
  /** Entries newly confirmed (receipted) in this call. */
  confirmed: number;
  /** Entries sent in this call (pending until confirmed). */
  sent: number;
  /** Entries already receipted, already pending-and-still-processing, or in flight. */
  skipped: number;
  /** Messages that could not be minimised safely, so were never sent. */
  dropped: number;
  /** Single entries longer than a batch can carry: held, never sent (visible, not silent). */
  tooLong: number;
  /** Pending submissions whose read-back did NOT match: cleared so they can be re-sent. */
  mismatched: number;
};

/** Split items into batches whose batchText fits MAX_BATCH_CHARS. Oversized single items are returned separately. */
export function toBatches(items: IngestItem[]): { batches: IngestItem[][]; tooLong: IngestItem[] } {
  const batches: IngestItem[][] = [];
  const tooLong: IngestItem[] = [];
  let cur: IngestItem[] = [];
  for (const it of items) {
    if (batchText([it]).length > MAX_BATCH_CHARS) {
      tooLong.push(it);
      continue;
    }
    if (cur.length > 0 && batchText([...cur, it]).length > MAX_BATCH_CHARS) {
      batches.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length > 0) {
    batches.push(cur);
  }
  return { batches, tooLong };
}

export async function captureWithReceipts(opts: {
  client: MemoryClient;
  ledger: ReceiptLedger;
  groupId: string;
  messages: ExtractedMessage[];
  /** `${groupId}\0${hash}` keys currently being processed (process-wide). */
  inFlight: Set<string>;
}): Promise<CaptureResult> {
  const { client, ledger, groupId, messages, inFlight } = opts;
  const res: CaptureResult = {
    confirmed: 0,
    sent: 0,
    skipped: 0,
    dropped: 0,
    tooLong: 0,
    mismatched: 0,
  };
  const byHash = new Map<string, IngestItem>();
  for (const m of messages) {
    const text = minimiseForMemory(m.content);
    if (text === null) {
      res.dropped++;
      continue;
    }
    const item: IngestItem = { role: m.roleType, text };
    byHash.set(entryHash(item), item);
  }
  const key = (h: string) => `${groupId}\u0000${h}`;
  const covered = await ledger.covered(groupId, [...byHash.keys()]);
  const open = [...byHash.keys()].filter((h) => !covered.has(h) && !inFlight.has(key(h)));
  res.skipped += byHash.size - open.length;
  if (open.length === 0) {
    return res;
  }
  for (const h of open) {
    inFlight.add(key(h));
  }
  try {
    const receipt = async (hashes: string[], episodeIds: string[]) => {
      const items = hashes.map((h) => byHash.get(h)!);
      await ledger.record(buildReceipt(client.label, groupId, items, episodeIds));
      await ledger.clearPending(groupId, hashes);
      res.confirmed += hashes.length;
    };

    // (3) Re-check what was already sent. Group pending entries by submission.
    const pend = await ledger.pending(groupId, open);
    const byRef = new Map<string, string[]>();
    for (const [h, ref] of pend) {
      byRef.set(ref, [...(byRef.get(ref) ?? []), h]);
    }
    for (const [ref, hashes] of byRef) {
      try {
        const r = await client.confirm(
          groupId,
          hashes.map((h) => byHash.get(h)!),
          { ref },
        );
        if (r.status === "confirmed") {
          await receipt(hashes, r.episodeIds);
        } else {
          res.skipped += hashes.length; // still processing: re-checked next time
        }
      } catch (err) {
        if (err instanceof IngestNotConfirmedError && err.reason === "readback_mismatch") {
          await ledger.clearPending(groupId, hashes); // allow a clean re-send next time
          res.mismatched += hashes.length;
        } else {
          res.skipped += hashes.length; // transient: stay pending, re-check next time
        }
      }
    }

    // (4) Send what was never sent.
    const fresh = open.filter((h) => !pend.has(h));
    const { batches, tooLong } = toBatches(fresh.map((h) => byHash.get(h)!));
    res.tooLong = tooLong.length;
    let firstError: unknown;
    for (const batch of batches) {
      const hashes = batch.map(entryHash);
      try {
        const sub = await client.submit(groupId, batch);
        await ledger.addPending(groupId, hashes, sub.ref, client.label);
        res.sent += hashes.length;
        const r = await client.confirm(groupId, batch, sub);
        if (r.status === "confirmed") {
          await receipt(hashes, r.episodeIds);
        }
      } catch (err) {
        firstError ??= err; // keep going with other batches; surface the failure after
      }
    }
    if (firstError) {
      throw firstError;
    }
    return res;
  } finally {
    for (const h of open) {
      inFlight.delete(key(h));
    }
  }
}
