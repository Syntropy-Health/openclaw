/**
 * Operator forget (CTO #16929): one user's memory group, receipts and transcript
 * files are erased; NOTHING of another user is touched; counts only; idempotent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetUser, userTranscriptFiles } from "./forget.js";
import { createMemoryReceiptLedger, opaqueGroupId } from "./receipts.js";

const PEPPER = "b".repeat(64);
const opaque = (raw: string) => opaqueGroupId(raw, PEPPER);

const USERS: Record<string, { external_id: string | null; peers: string[] }> = {
  "uuid-A": { external_id: "user_AAAAAAAAAAAAAAAAAAAAAAAA", peers: ["+15550000001"] },
  "uuid-B": { external_id: "user_BBBBBBBBBBBBBBBBBBBBBBBB", peers: ["+15550000002"] },
};

/** Fake identity DB answering the two queries forgetUser makes. */
const fakeSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const q = strings.join("?");
  const id = values[0] as string;
  if (q.includes("FROM lp_users")) {
    return USERS[id] ? [{ id, external_id: USERS[id].external_id }] : [];
  }
  if (q.includes("FROM lp_user_channels")) {
    return (USERS[id]?.peers ?? []).map((p) => ({ channel_peer_id: p }));
  }
  return [];
}) as unknown as Parameters<typeof forgetUser>[0]["sql"];

let stateDir: string;
let sessions: string;
const write = (name: string, body = "{}\n") => fs.writeFileSync(path.join(sessions, name), body);

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-forget-"));
  sessions = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "sessions.json"),
    JSON.stringify({
      "agent:main:openresponses-user:user_AAAAAAAAAAAAAAAAAAAAAAAA": { sessionId: "sA1" },
      "agent:main:whatsapp:direct:+15550000001": { sessionFile: "sA2.jsonl" },
      "agent:main:openresponses-user:user_BBBBBBBBBBBBBBBBBBBBBBBB": { sessionId: "sB1" },
      "agent:main:whatsapp:direct:+155500000011": { sessionId: "sNear" }, // prefix-collision decoy
    }),
  );
  for (const f of [
    "sA1.jsonl",
    "sA1.jsonl.deleted.2026-10-01",
    "sA2.jsonl",
    "sB1.jsonl",
    "sNear.jsonl",
  ]) {
    write(f);
  }
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function setup() {
  const forget = vi.fn(async (_g: string) => {});
  const ledger = createMemoryReceiptLedger();
  const receipt = (g: string) => ({
    store: "zep-cloud",
    groupId: g,
    episodeIds: ["ep"],
    entryHashes: ["h1", "h2"],
    contentHash: "c",
    ingestedAt: "t",
  });
  return { forget, ledger, receipt };
}

describe("forgetUser", () => {
  it("erases A's store group, receipts and transcripts — and only A's", async () => {
    const { forget, ledger, receipt } = setup();
    const gA = opaque(USERS["uuid-A"].external_id!);
    const gB = opaque(USERS["uuid-B"].external_id!);
    await ledger.record(receipt(gA));
    await ledger.record(receipt(gB));

    const r = await forgetUser({
      sql: fakeSql,
      client: { forget },
      ledger,
      opaque,
      userId: "uuid-A",
      stateDir,
    });

    expect(r).toEqual({ userFound: true, storeGroups: 2, receipts: 2, transcripts: 3 });
    expect(forget).toHaveBeenCalledWith(gA);
    expect(forget).not.toHaveBeenCalledWith(gB);
    expect((await ledger.covered(gB, ["h1", "h2"])).size).toBe(2); // B untouched
    const left = fs.readdirSync(sessions).sort();
    expect(left).toEqual(["sB1.jsonl", "sNear.jsonl", "sessions.json"]);
  });

  it("is idempotent: a second run deletes nothing more", async () => {
    const { forget, ledger } = setup();
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
    expect(r2.receipts).toBe(0);
    expect(r2.transcripts).toBe(0);
  });

  it("an unknown user id finds no transcripts and reports userFound=false", async () => {
    const { forget, ledger } = setup();
    const r = await forgetUser({
      sql: fakeSql,
      client: { forget },
      ledger,
      opaque,
      userId: "uuid-nobody",
      stateDir,
    });
    expect(r.userFound).toBe(false);
    expect(r.transcripts).toBe(0);
    expect(fs.readdirSync(sessions)).toHaveLength(6);
  });
});

describe("userTranscriptFiles", () => {
  it("matches a session-key SEGMENT exactly, never a prefix or substring", () => {
    const files = userTranscriptFiles(sessions, new Set(["+15550000001"])).map((f) =>
      path.basename(f),
    );
    expect(files).toEqual(["sA2.jsonl"]);
  });
});
