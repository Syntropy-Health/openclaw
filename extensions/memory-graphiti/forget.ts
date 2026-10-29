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
import { extractMessages } from "./messages.js";
import { leadingIdentityExternalId, minimiseForMemory } from "./minimise.js";
import { entryHash, type ReceiptLedger } from "./receipts.js";

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
  /** Files that disappeared between listing and reading/deleting (concurrent rename): re-run. */
  vanished: number;
};

/** Live + archived transcript files (never locks, never sessions.json). */
const TRANSCRIPT = /\.jsonl(\.(deleted|reset|bak)\.[^/\\]+)?$/;
/** HTTP session keys: agent:<agent>:<prefix>-user:<lowercased verified sub>[:hint]. */
const HTTP_USER_PREFIX = /^(openresponses|openai)-user$/;
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
function basesForPeers(
  dir: string,
  peers: Array<{ channel: string; peer: string }>,
  externalId: string | null,
): Set<string> {
  const bases = new Set<string>();
  const indexPath = path.join(dir, "sessions.json");
  if ((peers.length === 0 && !externalId) || !fs.existsSync(indexPath)) {
    return bases;
  }
  const sub = externalId?.toLowerCase() ?? null;
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
    // HTTP: the key's scope segment is the server-derived, lowercased verified sub
    // (not client-chosen when a Clerk token is present). Channel peers: same channel
    // AND the whole peer.
    const httpHit = sub !== null && HTTP_USER_PREFIX.test(channel) && rest[0] === sub;
    const hit =
      httpHit ||
      peers.some((p) => p.channel.toLowerCase() === channel && p.peer.toLowerCase() === peerPart);
    const file = entry?.sessionFile ?? (entry?.sessionId ? `${entry.sessionId}.jsonl` : null);
    if (hit && file) {
      bases.add(path.basename(file));
    }
  }
  return bases;
}

/** User/assistant messages of a transcript file (null if it vanished). */
function messagesIn(file: string): unknown[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // renamed/removed concurrently (archive, retention sweep)
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const e = JSON.parse(line) as { message?: unknown };
      if (e && typeof e === "object" && e.message) {
        out.push(e.message);
      }
    } catch {
      // not a JSON entry
    }
  }
  return out;
}

/**
 * The external_ids named by SYSTEM-injected identity blocks in this file (the
 * leading block region of user turns only — never text a person typed).
 */
function externalIdsIn(file: string): Set<string> | null {
  const msgs = messagesIn(file);
  if (msgs === null) {
    return null;
  }
  const ids = new Set<string>();
  for (const m of extractMessages(msgs)) {
    if (m.roleType !== "user") {
      continue;
    }
    const id = leadingIdentityExternalId(m.content);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

/** Decide which transcript files in `dir` are this user's. */
export function userTranscriptFiles(
  dir: string,
  user: { externalId: string | null; peers: Array<{ channel: string; peer: string }> },
): { files: string[]; sharedSkipped: number; vanished: number } {
  const bases = basesForPeers(
    dir,
    user.peers.filter((p) => !CLIENT_SUPPLIED_PEER_CHANNELS.has(p.channel.toLowerCase())),
    user.externalId,
  );
  const files: string[] = [];
  let sharedSkipped = 0;
  let vanished = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!TRANSCRIPT.test(f)) {
      continue;
    }
    const full = path.join(dir, f);
    const ids = externalIdsIn(full);
    if (ids === null) {
      vanished++;
      continue;
    }
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
  return { files, sharedSkipped, vanished };
}

/** Hash-only tombstones for every user/assistant entry in these transcript files. */
export function tombstonesFor(files: string[]): string[] {
  const hashes = new Set<string>();
  for (const file of files) {
    for (const m of extractMessages(messagesIn(file) ?? [])) {
      const t = minimiseForMemory(m.content);
      if (t !== null) {
        hashes.add(entryHash({ role: m.roleType, text: t }));
      }
    }
  }
  return [...hashes];
}

/** Serialises work on a set of memory groups (shared with capture, in-process). */
export type GroupLock = <T>(groups: string[], fn: () => Promise<T>) => Promise<T>;

type ForgetDeps = {
  /** Wait for in-flight captures of these groups before erasing (else a late upload survives). */
  lock?: GroupLock;
  sql: Sql;
  client: Pick<MemoryClient, "forget">;
  ledger: Pick<ReceiptLedger, "deleteGroup" | "addTombstones">;
  /** The plugin's opaque group-id function (keyed by the pepper). */
  opaque: (raw: string) => string;
  stateDir: string;
};

const emptyResult = (): ForgetResult => ({
  userFound: false,
  storeGroupsDeleted: 0,
  storeGroupsAbsent: 0,
  receipts: 0,
  transcripts: 0,
  sharedSkipped: 0,
  lockedSkipped: 0,
  vanished: 0,
});

/** The erase itself, for an already-resolved identity. */
async function forgetIdentity(
  deps: ForgetDeps,
  identity: {
    internalIds: string[];
    externalId: string | null;
    channels: Array<{ channel: string; channel_peer_id: string }>;
  },
  res: ForgetResult,
): Promise<ForgetResult> {
  const { opaque } = deps;
  // Every scope this user's memory can be keyed under: the verified external id
  // (the approval path), the internal id(s) and channel:peer (identity fallbacks).
  const groups = [
    ...new Set(
      [
        identity.externalId,
        ...identity.internalIds,
        ...identity.channels
          .filter((c) => !CLIENT_SUPPLIED_PEER_CHANNELS.has(c.channel.toLowerCase()))
          .map((c) => `${c.channel}:${c.channel_peer_id}`),
      ]
        .filter((s): s is string => Boolean(s))
        .map(opaque),
    ),
  ];

  const lock: GroupLock = deps.lock ?? ((_g, fn) => fn());
  return lock(groups, () => eraseLocked(deps, identity, groups, res));
}

async function eraseLocked(
  deps: ForgetDeps,
  identity: {
    internalIds: string[];
    externalId: string | null;
    channels: Array<{ channel: string; channel_peer_id: string }>;
  },
  groups: string[],
  res: ForgetResult,
): Promise<ForgetResult> {
  const { client, ledger, stateDir } = deps;
  // 1. Find the user's transcripts and TOMBSTONE their entries FIRST, so a capture
  //    that runs from here on (the live session still replays them) never re-sends.
  const dirs = sessionsDirs(stateDir);
  if (dirs.length === 0) {
    throw Object.assign(new Error("no sessions directory under the state dir"), {
      code: "misconfigured",
    });
  }
  const perDir = dirs.map((dir) => ({
    dir,
    ...userTranscriptFiles(dir, {
      externalId: identity.externalId,
      peers: identity.channels.map((c) => ({ channel: c.channel, peer: c.channel_peer_id })),
    }),
  }));
  const tombs = tombstonesFor(perDir.flatMap((d) => d.files));
  for (const g of groups) {
    await ledger.addTombstones(g, tombs);
  }

  // 2. The store and the ledger.
  for (const g of groups) {
    if (await client.forget(g)) {
      res.storeGroupsDeleted++;
    } else {
      res.storeGroupsAbsent++;
    }
    res.receipts += await ledger.deleteGroup(g);
  }

  // 3. The transcripts.
  for (const { files, sharedSkipped, vanished } of perDir) {
    res.sharedSkipped += sharedSkipped;
    res.vanished += vanished;
    for (const file of files) {
      const live = file.replace(/(\.jsonl)\..*$/, "$1");
      if (fs.existsSync(`${live}.lock`)) {
        res.lockedSkipped++;
        continue;
      }
      try {
        fs.rmSync(file);
        res.transcripts++;
      } catch {
        res.vanished++;
      }
    }
  }
  return res;
}

/** Operator path: erase by internal user id (lp_users.id). Unknown id: touches nothing. */
export async function forgetUser(opts: ForgetDeps & { userId: string }): Promise<ForgetResult> {
  const res = emptyResult();
  const users = await opts.sql<{ id: string; external_id: string | null }>`
    SELECT id, external_id FROM lp_users WHERE id = ${opts.userId} LIMIT 1`;
  const user = users[0];
  if (!user) {
    return res;
  }
  res.userFound = true;
  const channels = await opts.sql<{ channel: string; channel_peer_id: string }>`
    SELECT channel, channel_peer_id FROM lp_user_channels WHERE user_id = ${opts.userId}`;
  return forgetIdentity(
    opts,
    { internalIds: [user.id], externalId: user.external_id, channels },
    res,
  );
}

/**
 * Self-service path ("Clear chat memory"): erase by the VERIFIED Clerk sub. Works
 * whether or not an lp_users row exists — the external-id group and the user's
 * HTTP transcripts are found from the sub alone.
 */
export async function forgetByExternalId(
  opts: ForgetDeps & { externalId: string },
): Promise<ForgetResult> {
  const res = emptyResult();
  const users = await opts.sql<{ id: string }>`
    SELECT id FROM lp_users WHERE external_id = ${opts.externalId}`;
  const ids = users.map((u) => u.id);
  res.userFound = ids.length > 0;
  const channels =
    ids.length > 0
      ? await opts.sql<{ channel: string; channel_peer_id: string }>`
          SELECT channel, channel_peer_id FROM lp_user_channels WHERE user_id = ANY(${ids})`
      : [];
  return forgetIdentity(opts, { internalIds: ids, externalId: opts.externalId, channels }, res);
}

/** The definite outcome the API reports: SUCCEEDED only when nothing was left behind. */
export function forgetOutcome(r: ForgetResult): {
  status: "SUCCEEDED" | "FAILED";
  retryable: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (r.lockedSkipped > 0) {
    reasons.push("transcript_locked");
  }
  if (r.vanished > 0) {
    reasons.push("transcript_moved");
  }
  if (r.sharedSkipped > 0) {
    reasons.push("transcript_shared");
  }
  return reasons.length === 0
    ? { status: "SUCCEEDED", retryable: false, reasons }
    : {
        status: "FAILED",
        // A shared file needs a human; locked/moved files clear on a retry.
        retryable: !reasons.includes("transcript_shared"),
        reasons,
      };
}
