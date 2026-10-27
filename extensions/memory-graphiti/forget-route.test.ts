/**
 * POST /gateway/memory/forget (CTO #17002): the verified Clerk user only; a
 * definite SUCCEEDED/FAILED; idempotent; and a cleared conversation is never
 * re-uploaded by the live session's replay (tombstones).
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWithReceipts } from "./capture.js";
import type { MemoryClient } from "./client.js";
import { createForgetHandler, type ForgetRouteDeps } from "./forget-route.js";
import { forgetByExternalId, forgetOutcome, type ForgetResult } from "./forget.js";
import { createMemoryReceiptLedger, opaqueGroupId } from "./receipts.js";

const CLERK = { issuer: "i" } as unknown as NonNullable<
  ReturnType<ForgetRouteDeps["resolveClerk"]>
>;
const SUB = "user_2AbCdEfGhIjKlMnOpQrStUv";

function call(
  handler: ReturnType<typeof createForgetHandler>,
  init: { method?: string; headers?: Record<string, string>; url?: string } = {},
) {
  const req = {
    method: init.method ?? "POST",
    url: init.url ?? "/gateway/memory/forget",
    headers: init.headers ?? { authorization: "Bearer good" },
  } as unknown as IncomingMessage;
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    end: (b: string) => {
      body = b;
    },
  } as unknown as ServerResponse;
  return handler(req, res).then(() => ({ status, json: body ? JSON.parse(body) : null }));
}

const ok = (over: Partial<ForgetResult> = {}): ForgetResult => ({
  userFound: true,
  storeGroupsDeleted: 1,
  storeGroupsAbsent: 0,
  receipts: 3,
  transcripts: 2,
  sharedSkipped: 0,
  lockedSkipped: 0,
  vanished: 0,
  ...over,
});

function deps(over: Partial<ForgetRouteDeps> = {}) {
  const forget = vi.fn(async (_ext: string) => ok());
  const d: ForgetRouteDeps = {
    resolveClerk: () => CLERK,
    verifyJwt: async (t) => (t === "good" ? { ok: true, externalId: SUB } : { ok: false }),
    forget,
    ...over,
  };
  return { d, forget };
}

describe("POST /gateway/memory/forget — auth", () => {
  it("405 for anything but POST", async () => {
    const { d, forget } = deps();
    expect((await call(createForgetHandler(d), { method: "GET" })).status).toBe(405);
    expect(forget).not.toHaveBeenCalled();
  });

  it.each([
    ["no bearer", { headers: {} }, {}],
    ["invalid token", { headers: { authorization: "Bearer bad" } }, {}],
    ["Clerk not configured", {}, { resolveClerk: () => undefined }],
    [
      "verify throws",
      {},
      {
        verifyJwt: async () => {
          throw new Error("jwks down");
        },
      },
    ],
  ])("401 when %s, and nothing is erased", async (_l, init, over) => {
    const { d, forget } = deps(over as Partial<ForgetRouteDeps>);
    const r = await call(createForgetHandler(d), init);
    expect(r.status).toBe(401);
    expect(forget).not.toHaveBeenCalled();
  });

  it("erases ONLY the token's verified user — a caller-supplied id is never read", async () => {
    const { d, forget } = deps();
    await call(createForgetHandler(d), {
      url: "/gateway/memory/forget?userId=user_victim&externalId=user_victim",
      headers: {
        authorization: "Bearer good",
        "x-openclaw-user": "user_victim",
        "x-user-id": "user_victim",
      },
    });
    expect(forget).toHaveBeenCalledOnce();
    expect(forget).toHaveBeenCalledWith(SUB);
  });
});

describe("POST /gateway/memory/forget — definite outcome", () => {
  it("SUCCEEDED with counts when everything cleared", async () => {
    const { d } = deps();
    const r = await call(createForgetHandler(d));
    expect(r).toEqual({
      status: 200,
      json: {
        status: "SUCCEEDED",
        retryable: false,
        reasons: [],
        counts: { storeGroupsDeleted: 1, storeGroupsAbsent: 0, receipts: 3, transcripts: 2 },
      },
    });
  });

  it("FAILED (retryable) when a transcript was locked — never 'cleared' with content left", async () => {
    const { d } = deps({ forget: async () => ok({ lockedSkipped: 1 }) });
    const r = await call(createForgetHandler(d));
    expect(r.json).toMatchObject({
      status: "FAILED",
      retryable: true,
      reasons: ["transcript_locked"],
    });
  });

  it("FAILED (retryable) on a store error", async () => {
    const { d } = deps({
      forget: async () => {
        throw new Error("zep 503");
      },
    });
    expect((await call(createForgetHandler(d))).json).toMatchObject({
      status: "FAILED",
      retryable: true,
      reasons: ["store_error"],
    });
  });

  it("FAILED (not retryable) when memory is misconfigured (no pepper)", async () => {
    const { d } = deps({ forget: null });
    expect((await call(createForgetHandler(d))).json).toMatchObject({
      status: "FAILED",
      retryable: false,
      reasons: ["misconfigured"],
    });
  });

  it("forgetOutcome: shared files need a human (not retryable); moved files are retryable", () => {
    expect(forgetOutcome(ok({ sharedSkipped: 1 }))).toMatchObject({
      status: "FAILED",
      retryable: false,
    });
    expect(forgetOutcome(ok({ vanished: 1 }))).toMatchObject({ status: "FAILED", retryable: true });
    expect(forgetOutcome(ok())).toMatchObject({ status: "SUCCEEDED" });
  });
});

describe("forgetByExternalId + tombstones (end to end, real files)", () => {
  const PEPPER = "c".repeat(64);
  const opaque = (raw: string) => opaqueGroupId(raw, PEPPER);
  let stateDir: string;
  let sessions: string;
  const entry = (role: string, text: string) =>
    JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-forget-api-"));
    sessions = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    // A webchat user with NO lp_users row: found by the server-derived HTTP key.
    fs.writeFileSync(
      path.join(sessions, "sessions.json"),
      JSON.stringify({
        [`agent:main:openresponses-user:${SUB.toLowerCase()}`]: { sessionId: "w1" },
      }),
    );
    fs.writeFileSync(
      path.join(sessions, "w1.jsonl"),
      [entry("user", "I slept badly"), entry("assistant", "Sorry to hear that.")].join("\n") + "\n",
    );
    fs.writeFileSync(path.join(sessions, "other.jsonl"), entry("user", "someone else") + "\n");
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const noRows = (async () => []) as unknown as Parameters<typeof forgetByExternalId>[0]["sql"];

  it("clears the user's group, receipts and transcripts — then a live-session replay re-sends NOTHING", async () => {
    const ledger = createMemoryReceiptLedger();
    const g = opaque(SUB);
    await ledger.record({
      store: "zep-cloud",
      groupId: g,
      episodeIds: ["ep"],
      entryHashes: ["h"],
      contentHash: "c",
      ingestedAt: "t",
    });
    const zepForget = vi.fn(async () => true);

    const r = await forgetByExternalId({
      sql: noRows,
      client: { forget: zepForget },
      ledger,
      opaque,
      externalId: SUB,
      stateDir,
    });
    expect(forgetOutcome(r).status).toBe("SUCCEEDED");
    expect(zepForget).toHaveBeenCalledWith(g);
    expect(r.receipts).toBe(1);
    expect(fs.readdirSync(sessions).sort()).toEqual(["other.jsonl", "sessions.json"]);

    // The gateway's in-memory session still holds the turns; agent_end replays them.
    const submit = vi.fn(async (_g: string, _items: unknown[]) => ({ ref: "ep-2" }));
    const client = {
      label: "z",
      submit,
      confirm: vi.fn(async () => ({ status: "confirmed", episodeIds: ["ep-2"] })),
    } as unknown as MemoryClient;
    const replay = await captureWithReceipts({
      client,
      ledger,
      groupId: g,
      messages: [
        { content: "I slept badly", roleType: "user" },
        { content: "Sorry to hear that.", roleType: "assistant" },
        { content: "a NEW message after clearing", roleType: "user" },
      ],
      inFlight: new Set(),
    });
    expect(replay.tombstoned).toBe(2);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][1]).toEqual([
      { role: "user", text: "a NEW message after clearing" },
    ]);
  });

  it("is idempotent: a second call clears nothing more and is SUCCEEDED", async () => {
    const ledger = createMemoryReceiptLedger();
    const args = {
      sql: noRows,
      client: { forget: vi.fn(async () => false) },
      ledger,
      opaque,
      externalId: SUB,
      stateDir,
    };
    await forgetByExternalId(args);
    const r2 = await forgetByExternalId(args);
    expect(r2).toMatchObject({ transcripts: 0, receipts: 0, storeGroupsDeleted: 0 });
    expect(forgetOutcome(r2).status).toBe("SUCCEEDED");
  });
});

describe("security review round (77865605b)", () => {
  it("401 when the Clerk session is revoked/signed-out (or the check throws) — nothing erased", async () => {
    for (const validateSession of [
      async () => false,
      async () => {
        throw new Error("clerk down");
      },
    ]) {
      const { d, forget } = deps({ validateSession });
      expect((await call(createForgetHandler(d))).status).toBe(401);
      expect(forget).not.toHaveBeenCalled();
    }
  });

  it("passes the session-id header (a lookup key) to the session check, with the token's sub", async () => {
    const validateSession = vi.fn(async () => true);
    const { d } = deps({ validateSession });
    await call(createForgetHandler(d), {
      headers: { authorization: "Bearer good", "x-openclaw-clerk-session-id": "sess_1" },
    });
    expect(validateSession).toHaveBeenCalledWith(SUB, "sess_1");
  });

  it("one erase per user at a time, and a short cooldown after (abuse guard)", async () => {
    let t = 1_000;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const forget = vi.fn(async () => (await gate, ok()));
    const { d } = deps({ forget, now: () => t, cooldownMs: 5_000 });
    const h = createForgetHandler(d);
    const first = call(h);
    await new Promise((r) => setTimeout(r, 0));
    expect((await call(h)).json).toMatchObject({ status: "FAILED", reasons: ["in_progress"] });
    releaseFirst();
    expect((await first).json.status).toBe("SUCCEEDED");
    t += 1_000;
    expect((await call(h)).json).toMatchObject({ status: "FAILED", reasons: ["rate_limited"] });
    t += 5_000;
    expect((await call(h)).json.status).toBe("SUCCEEDED");
    expect(forget).toHaveBeenCalledTimes(2);
  });

  it("no sessions directory = FAILED misconfigured (an empty scan must never read as 'cleared')", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-forget-nodir-"));
    try {
      const { d } = deps({
        forget: (ext) =>
          forgetByExternalId({
            sql: (async () => []) as unknown as Parameters<typeof forgetByExternalId>[0]["sql"],
            client: { forget: async () => true },
            ledger: createMemoryReceiptLedger(),
            opaque: (r) => r,
            externalId: ext,
            stateDir: empty,
          }),
      });
      expect((await call(createForgetHandler(d))).json).toMatchObject({
        status: "FAILED",
        retryable: false,
        reasons: ["misconfigured"],
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
