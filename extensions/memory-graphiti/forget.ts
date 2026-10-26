/**
 * Operator-side forget (CTO #16929): erase ONE user's memory everywhere openclaw
 * put it, given their internal user id (lp_users.id).
 *
 * Deletes:
 *   1. the user's memory group(s) at the store (adapter.forget — Zep user delete),
 *   2. their receipt and pending rows (ledger.deleteGroup),
 *   3. their session transcript files (and archived .deleted./.reset. copies).
 *
 * Prints COUNTS only — never ids, names, paths or content. Idempotent: a second
 * run finds nothing and reports zeros. Touches nothing of any other user: groups
 * are derived from this user's own identity, and a transcript is chosen only when
 * one of its session-key SEGMENTS equals one of this user's own identifiers.
 *
 * The user-facing trigger (in chat, or from SJ's data-deletion flow) is #595.
 */
import fs from "node:fs";
import path from "node:path";
import type { MemoryClient } from "./client.js";
import type { ReceiptLedger } from "./receipts.js";

type Sql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export type ForgetResult = {
  userFound: boolean;
  storeGroups: number;
  receipts: number;
  transcripts: number;
};

const TRANSCRIPT = /\.jsonl(\.(deleted|reset)\.[^/\\]+)?$/;

/** Every `<stateDir>/agents/<agent>/sessions` directory that exists. */
export function sessionsDirs(stateDir: string): string[] {
  const agents = path.join(stateDir, "agents");
  if (!fs.existsSync(agents)) {
    return [];
  }
  return fs
    .readdirSync(agents)
    .map((a) => path.join(agents, a, "sessions"))
    .filter((d) => fs.existsSync(d));
}

/** Transcript files (live + archived) belonging to session keys that name one of `ids`. */
export function userTranscriptFiles(dir: string, ids: Set<string>): string[] {
  const indexPath = path.join(dir, "sessions.json");
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  let index: Record<string, { sessionId?: string; sessionFile?: string }>;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return [];
  }
  const bases = new Set<string>();
  for (const [key, entry] of Object.entries(index)) {
    // Exact SEGMENT match only: "u1" must never match "u10" or a substring.
    if (!key.split(":").some((seg) => ids.has(seg))) {
      continue;
    }
    const file = entry?.sessionFile ?? (entry?.sessionId ? `${entry.sessionId}.jsonl` : null);
    if (file) {
      bases.add(path.basename(file));
    }
  }
  if (bases.size === 0) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => TRANSCRIPT.test(f) && [...bases].some((b) => f === b || f.startsWith(`${b}.`)))
    .map((f) => path.join(dir, f));
}

export async function forgetUser(opts: {
  sql: Sql;
  client: Pick<MemoryClient, "forget">;
  ledger: Pick<ReceiptLedger, "deleteGroup">;
  /** The plugin's opaque group-id function (keyed when a pepper is configured). */
  opaque: (raw: string) => string;
  userId: string;
  stateDir: string;
}): Promise<ForgetResult> {
  const { sql, client, ledger, opaque, userId, stateDir } = opts;
  const res: ForgetResult = { userFound: false, storeGroups: 0, receipts: 0, transcripts: 0 };

  const users = await sql<{ id: string; external_id: string | null }>`
    SELECT id, external_id FROM lp_users WHERE id = ${userId} LIMIT 1`;
  const user = users[0];
  const peers = await sql<{ channel_peer_id: string }>`
    SELECT channel_peer_id FROM lp_user_channels WHERE user_id = ${userId}`;
  res.userFound = Boolean(user);

  // Every scope this user's memory can be keyed under: the verified external id
  // (the approval path) and the internal id (the identity strategy's fallback).
  const scopes = [user?.external_id, user?.id ?? userId].filter((s): s is string => Boolean(s));
  for (const scope of new Set(scopes)) {
    const group = opaque(scope);
    await client.forget(group);
    res.storeGroups++;
    res.receipts += await ledger.deleteGroup(group);
  }

  // Transcripts: session keys carrying this user's external id or channel peer ids.
  const ids = new Set(
    [user?.external_id, ...peers.map((p) => p.channel_peer_id)].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    ),
  );
  if (ids.size > 0) {
    for (const dir of sessionsDirs(stateDir)) {
      for (const file of userTranscriptFiles(dir, ids)) {
        fs.rmSync(file, { force: true });
        res.transcripts++;
      }
    }
  }
  return res;
}
