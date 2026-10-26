/**
 * Operator-side forget (CTO #16929): erase ONE user's memory everywhere openclaw
 * put it, given their internal user id (lp_users.id).
 *
 * Deletes:
 *   1. the user's memory group(s) at the store (adapter.forget — Zep user delete),
 *   2. their receipt and pending rows (ledger.deleteGroup),
 *   3. their session transcript files, live AND archived (.deleted./.reset./.bak).
 *
 * How transcripts are chosen — never by a loose identifier match (re-gate review):
 *   - CONTENT: a file is the user's when its identity blocks carry
 *     `external_id: <their exact Clerk id>` (case-preserved, whole token). That
 *     finds archives too, whose index entry is gone. A file that ALSO carries
 *     another user's external_id (a shared session) is NOT deleted; it is
 *     counted as `sharedSkipped`.
 *   - KEY: for channel peers, the session key must name the SAME channel and the
 *     WHOLE peer (case-insensitive, as keys are lowercased). shrinemobile device
 *     ids are client-supplied and never used as a selector.
 *   - A file with a `.lock` beside it (the gateway is writing it) is skipped and
 *     counted as `lockedSkipped`.
 *
 * Prints COUNTS only. Idempotent. Run with the user's traffic stopped: a turn in
 * flight can re-create a transcript or memory after the erase.
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
  /** Store groups that existed and were deleted. */
  storeGroupsDeleted: number;
  /** Store groups that were already absent. */
  storeGroupsAbsent: number;
  receipts: number;
  transcripts: number;
  /** Files carrying this user AND someone else: kept, needs manual review. */
  sharedSkipped: number;
  /** Files the gateway holds a lock on: kept, re-run when idle. */
  lockedSkipped: number;
};

/** Live + archived transcript files (never locks, never sessions.json). */
const TRANSCRIPT = /\.jsonl(\.(deleted|reset|bak)\.[^/\\]+)?$/;
const EXTERNAL_ID = /external_id:\s*([^\s"\\]+)/g;
/** Channels whose "peer" is a client-supplied device id: never a deletion selector. */
const CLIENT_SUPPLIED_PEER_CHANNELS = new Set(["shrinemobile", "webchat"]);

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

/** Transcript bases (live session files) whose key names one of `peers` on its own channel. */
function basesForPeers(dir: string, peers: Array<{ channel: string; peer: string }>): Set<string> {
  const bases = new Set<string>();
  const indexPath = path.join(dir, "sessions.json");
  if (peers.length === 0 || !fs.existsSync(indexPath)) {
    return bases;
  }
  let index: Record<string, { sessionId?: string; sessionFile?: string }>;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return bases;
  }
  for (const [key, entry] of Object.entries(index)) {
    const parts = key.toLowerCase().split(":");
    if (parts[0] !== "agent" || parts.length < 4) {
      continue;
    }
    const channel = parts[2];
    const rest = parts.slice(3);
    const peerPart = rest[0] === "direct" ? rest.slice(1).join(":") : rest.join(":");
    const hit = peers.some(
      (p) => p.channel.toLowerCase() === channel && p.peer.toLowerCase() === peerPart,
    );
    const file = entry?.sessionFile ?? (entry?.sessionId ? `${entry.sessionId}.jsonl` : null);
    if (hit && file) {
      bases.add(path.basename(file));
    }
  }
  return bases;
}

/** The external_ids an identity block in this file names. */
function externalIdsIn(file: string): Set<string> {
  const ids = new Set<string>();
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(EXTERNAL_ID)) {
    if (m[1] && m[1] !== "none") {
      ids.add(m[1]);
    }
  }
  return ids;
}

/** Decide which transcript files in `dir` are this user's. */
export function userTranscriptFiles(
  dir: string,
  user: { externalId: string | null; peers: Array<{ channel: string; peer: string }> },
): { files: string[]; sharedSkipped: number } {
  const bases = basesForPeers(
    dir,
    user.peers.filter((p) => !CLIENT_SUPPLIED_PEER_CHANNELS.has(p.channel.toLowerCase())),
  );
  const files: string[] = [];
  let sharedSkipped = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!TRANSCRIPT.test(f)) {
      continue;
    }
    const full = path.join(dir, f);
    const ids = externalIdsIn(full);
    const byContent = user.externalId !== null && ids.has(user.externalId);
    const byKey = [...bases].some((b) => f === b || f.startsWith(`${b}.`));
    if (!byContent && !byKey) {
      continue;
    }
    const others = [...ids].filter((id) => id !== user.externalId);
    if (others.length > 0) {
      sharedSkipped++; // carries another user too: never delete someone else's content
      continue;
    }
    files.push(full);
  }
  return { files, sharedSkipped };
}

export async function forgetUser(opts: {
  sql: Sql;
  client: Pick<MemoryClient, "forget">;
  ledger: Pick<ReceiptLedger, "deleteGroup">;
  /** The plugin's opaque group-id function (keyed by the pepper). */
  opaque: (raw: string) => string;
  userId: string;
  stateDir: string;
}): Promise<ForgetResult> {
  const { sql, client, ledger, opaque, userId, stateDir } = opts;
  const res: ForgetResult = {
    userFound: false,
    storeGroupsDeleted: 0,
    storeGroupsAbsent: 0,
    receipts: 0,
    transcripts: 0,
    sharedSkipped: 0,
    lockedSkipped: 0,
  };

  const users = await sql<{ id: string; external_id: string | null }>`
    SELECT id, external_id FROM lp_users WHERE id = ${userId} LIMIT 1`;
  const user = users[0];
  if (!user) {
    return res; // unknown id: touch nothing
  }
  res.userFound = true;
  const channels = await sql<{ channel: string; channel_peer_id: string }>`
    SELECT channel, channel_peer_id FROM lp_user_channels WHERE user_id = ${userId}`;

  // Every scope this user's memory can be keyed under: the verified external id
  // (the approval path), the internal id and channel:peer (identity fallbacks).
  const scopes = new Set(
    [user.external_id, user.id, ...channels.map((c) => `${c.channel}:${c.channel_peer_id}`)].filter(
      (s): s is string => Boolean(s),
    ),
  );
  for (const scope of scopes) {
    const group = opaque(scope);
    if (await client.forget(group)) {
      res.storeGroupsDeleted++;
    } else {
      res.storeGroupsAbsent++;
    }
    res.receipts += await ledger.deleteGroup(group);
  }

  for (const dir of sessionsDirs(stateDir)) {
    const { files, sharedSkipped } = userTranscriptFiles(dir, {
      externalId: user.external_id,
      peers: channels.map((c) => ({ channel: c.channel, peer: c.channel_peer_id })),
    });
    res.sharedSkipped += sharedSkipped;
    for (const file of files) {
      const live = file.replace(/(\.jsonl)\..*$/, "$1");
      if (fs.existsSync(`${live}.lock`)) {
        res.lockedSkipped++;
        continue;
      }
      fs.rmSync(file, { force: true });
      res.transcripts++;
    }
  }
  return res;
}
