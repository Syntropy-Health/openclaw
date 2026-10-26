/**
 * Capture with receipts (A&D B + C). Replaces the fire-and-forget addMessages.
 *
 * 1. Minimise every message (identity and context blocks stripped; a message
 *    that cannot be made safe is dropped, never sent).
 * 2. Skip entries the ledger already covers. agent_end carries the WHOLE
 *    session every turn, so this is also de-duplication.
 * 3. Ingest the rest through the adapter, which resolves only after read-back.
 * 4. Record the receipt. No receipt ⇒ the transcript sweep holds that content.
 */
import type { MemoryClient } from "./client.js";
import { minimiseForMemory } from "./minimise.js";
import { entryHash, type IngestItem, type ReceiptLedger } from "./receipts.js";

export type ExtractedMessage = { content: string; roleType: "user" | "assistant" };

export type CaptureResult = {
  /** Entries sent and confirmed in this call. */
  ingested: number;
  /** Entries already covered by a receipt (or in flight). */
  skipped: number;
  /** Messages that could not be minimised safely, so were never sent. */
  dropped: number;
};

export async function captureWithReceipts(opts: {
  client: MemoryClient;
  ledger: ReceiptLedger;
  groupId: string;
  messages: ExtractedMessage[];
  /** `${groupId}\0${hash}` keys currently being ingested (process-wide). */
  inFlight: Set<string>;
}): Promise<CaptureResult> {
  const { client, ledger, groupId, messages, inFlight } = opts;
  let dropped = 0;
  const byHash = new Map<string, IngestItem>();
  for (const m of messages) {
    const text = minimiseForMemory(m.content);
    if (text === null) {
      dropped++;
      continue;
    }
    const item: IngestItem = { role: m.roleType, text };
    byHash.set(entryHash(item), item);
  }
  const hashes = [...byHash.keys()];
  const covered = await ledger.covered(groupId, hashes);
  const key = (h: string) => `${groupId}\u0000${h}`;
  const pending = hashes.filter((h) => !covered.has(h) && !inFlight.has(key(h)));
  const skipped = hashes.length - pending.length;
  if (pending.length === 0) {
    return { ingested: 0, skipped, dropped };
  }
  for (const h of pending) {
    inFlight.add(key(h));
  }
  try {
    const receipt = await client.ingest(
      groupId,
      pending.map((h) => byHash.get(h)!),
    );
    await ledger.record(receipt);
    return { ingested: receipt.entryHashes.length, skipped, dropped };
  } finally {
    for (const h of pending) {
      inFlight.delete(key(h));
    }
  }
}
