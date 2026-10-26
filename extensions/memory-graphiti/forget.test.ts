/**
 * Operator forget (CTO #16929, re-gate review): one user's store groups, receipts
 * and transcript files are erased; NOTHING of another user is touched; counts
 * only; idempotent. Fixtures are production-shaped: session keys are LOWERCASED
 * (routing/session-key.ts) while the Clerk id inside identity blocks keeps its case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetUser } from "./forget.js";
import { createMemoryReceiptLedger, opaqueGroupId } from "./receipts.js";

const PEPPER = "b".repeat(64);
const opaque = (raw: string) => opaqueGroupId(raw, PEPPER);

const A_SUB = "user_2AbCdEfGhIjKlMnOpQrStUv";
const B_SUB = "user_2ZyXwVuTsRqPoNmLkJiHgFe";
const USERS: Record<
  string,
  { external_id: string | null; channels: Array<{ channel: string; channel_peer_id: string }> }
> = {
  "uuid-A": {
    external_id: A_SUB,
    channels: [
      { channel: "whatsapp", channel_peer_id: "+15550000001" },
      // A client-supplied device id chosen to collide with key segments: must select nothing.
      { channel: "shrinemobile", channel_peer_id: "agent" },
    ],
  },
  "uuid-B": {
    external_id: B_SUB,
    channels: [{ channel: "whatsapp", channel_peer_id: "+15550000002" }],
  },
};

const fakeSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const q = strings.join("?");
  const id = values[0] as string;
  if (q.includes("FROM lp_users")) {
    return USERS[id] ? [{ id, external_id: USERS[id].external_id }] : [];
  }
  if (q.includes("FROM lp_user_channels")) {
    return USERS[id]?.channels ?? [];
  }
  return [];
}) as unknown as Parameters<typeof forgetUser>[0]["sql"];

/** One JSONL user turn carrying an identity block (JSON-escaped, as on disk). */
const turn = (...subs: string[]) =>
  subs
    .map((s) =>
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: `[USER_IDENTITY]\nexternal_id: ${s}\n[/USER_IDENTITY]\n\nhi`,
        },
      }),
    )
    .join("\n") + "\n";

let stateDir: string;
let sessions: string;
const write = (name: string, body: string) => fs.writeFileSync(path.join(sessions, name), body);

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-forget-"));
  sessions = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "sessions.json"),
    JSON.stringify({
      [`agent:main:openresponses-user:${A_SUB.toLowerCase()}`]: { sessionId: "sA1" },
      "agent:main:whatsapp:direct:+15550000001": { sessionFile: "sA2.jsonl" },
      [`agent:main:openresponses-user:${B_SUB.toLowerCase()}`]: { sessionId: "sB1" },
      "agent:main:whatsapp:direct:+155500000011": { sessionId: "sNear" }, // prefix decoy
      "agent:main:main": { sessionId: "sShared" },
      "agent:main:locked:x": { sessionId: "sLocked" },
      // webchat: no identity block is written; found by the server-derived HTTP key.
      [`agent:main:openresponses-user:${A_SUB.toLowerCase()}:web`]: { sessionId: "sAweb" },
    }),
  );
  write("sA1.jsonl", turn(A_SUB)); // A, found by content (key is lowercased)
  write("sA0.jsonl.reset.2026-10-01", turn(A_SUB)); // A archive, NOT in the index
  write("sA2.jsonl", '{"type":"message"}\n'); // A pre-verify WhatsApp: found by channel+peer
  write("sB1.jsonl", turn(B_SUB)); // B
  write("sNear.jsonl", '{"type":"message"}\n'); // decoy
  write("sShared.jsonl", turn(A_SUB, B_SUB)); // carries A AND B: must be kept
  write("sLocked.jsonl", turn(A_SUB));
  write("sAweb.jsonl", '{"type":"message"}\n');
  // A's own file where the user TYPED someone else's id in free text: not "shared".
  write("sAtyped.jsonl", turn(A_SUB) + JSON.stringify({ text: `external_id: ${B_SUB}` }) + "\n");
  write("sLocked.jsonl.lock", "");
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function store() {
  const existing = new Set<string>([opaque(A_SUB), opaque(B_SUB)]);
  const forget = vi.fn(async (g: string) => existing.delete(g));
  return { forget, existing };
}

describe("forgetUser", () => {
  it("erases A everywhere — and nothing of B, shared, locked or decoy files", async () => {
    const { forget, existing } = store();
    const ledger = createMemoryReceiptLedger();
    const receipt = (g: string) => ({
      store: "zep-cloud",
      groupId: g,
      episodeIds: ["ep"],
      entryHashes: ["h1", "h2"],
      contentHash: "c",
      ingestedAt: "t",
    });
    await ledger.record(receipt(opaque(A_SUB)));
    await ledger.record(receipt(opaque(B_SUB)));

    const r = await forgetUser({
      sql: fakeSql,
      client: { forget },
      ledger,
      opaque,
      userId: "uuid-A",
      stateDir,
    });

    expect(r).toMatchObject({
      userFound: true,
      storeGroupsDeleted: 1,
      receipts: 2,
      transcripts: 5,
      sharedSkipped: 1,
      lockedSkipped: 1,
    });
    expect(existing.has(opaque(B_SUB))).toBe(true);
    expect((await ledger.covered(opaque(B_SUB), ["h1", "h2"])).size).toBe(2);
    expect(fs.readdirSync(sessions).sort()).toEqual([
      "sB1.jsonl",
      "sLocked.jsonl",
      "sLocked.jsonl.lock",
      "sNear.jsonl",
      "sShared.jsonl",
      "sessions.json",
    ]);
  });

  it("a client-supplied device id that equals a key segment selects nothing", async () => {
    const { forget } = store();
    // B's run: B has no device id; this asserts A's "agent" device id did not, above,
    // turn into a wildcard. Here we check the converse: forgetting B leaves A's files.
    await forgetUser({
      sql: fakeSql,
      client: { forget },
      ledger: createMemoryReceiptLedger(),
      opaque,
      userId: "uuid-B",
      stateDir,
    });
    const left = fs.readdirSync(sessions);
    expect(left).toContain("sA1.jsonl");
    expect(left).toContain("sA2.jsonl");
    expect(left).not.toContain("sB1.jsonl");
  });

  it("is idempotent: a second run deletes nothing more and reports the group as absent", async () => {
    const { forget } = store();
    const ledger = createMemoryReceiptLedger();
    await forgetUser({
      sql: fakeSql,
      client: { forget },
      ledger,
      opaque,
      userId: "uuid-A",
      stateDir,
    });
    const r2 = await forgetUser({
      sql: fakeSql,
      client: { forget },
      ledger,
      opaque,
      userId: "uuid-A",
      stateDir,
    });
    expect(r2).toMatchObject({ storeGroupsDeleted: 0, receipts: 0, transcripts: 0 });
    expect(r2.storeGroupsAbsent).toBeGreaterThan(0);
  });

  it("an unknown user id touches NOTHING (no store call, no files)", async () => {
    const { forget } = store();
    const r = await forgetUser({
      sql: fakeSql,
      client: { forget },
      ledger: createMemoryReceiptLedger(),
      opaque,
      userId: "uuid-nobody",
      stateDir,
    });
    expect(r.userFound).toBe(false);
    expect(forget).not.toHaveBeenCalled();
    expect(fs.readdirSync(sessions)).toHaveLength(11);
  });
});
