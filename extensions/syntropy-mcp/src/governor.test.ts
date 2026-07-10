/**
 * ConfirmGovernor — the B4 CRIT regression locks.
 *
 * These tests are the point of B4: they assert the commit-arg binding guarantee
 * (the A&D's lone CRITICAL) and its supporting isolation/replay/edit properties.
 * They run against the REAL PendingConfirmStore (deterministic clock + id source)
 * so store isolation is exercised end-to-end, plus a minimal C1 descriptor.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import { PENDING_ID_PATTERN } from "../../../src/gateway/component-descriptor.schema.js";
import { ConfirmGovernor } from "./governor.js";
import { PendingConfirmStore } from "./pending-confirm-store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nowMs: number;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

function seqRandomId(): () => string {
  let n = 0;
  return () => `cnf_${String(n++).padStart(22, "0")}`;
}

function makeStore(): PendingConfirmStore {
  return new PendingConfirmStore({ now, ttlSeconds: 300, randomId: seqRandomId() });
}

function makeGovernor(store: PendingConfirmStore, commitTools: string[] = ["syntropy_log_food"]) {
  return new ConfirmGovernor(store, {
    commitToolsByServer: new Map([["sj", new Set(commitTools)]]),
    now,
  });
}

/** A C1 initiate-result: the ComponentDescriptor rides under details.component. */
function foodResult(overrides?: {
  commitTool?: string | null;
  fields?: unknown[];
}): AgentToolResult<unknown> {
  const ui: Record<string, unknown> = {
    summary: "Log salmon, 340 kcal?",
    fields: overrides?.fields ?? [
      { name: "food_name", type: "string", value: "salmon" },
      { name: "calories", type: "number", value: 340, constraints: { min: 0 } },
    ],
  };
  if (overrides?.commitTool !== undefined) {
    ui.commit_tool = overrides.commitTool;
  } else {
    ui.commit_tool = "syntropy_log_food";
  }
  return {
    content: [{ type: "text", text: "analyzed" }],
    details: { component: { type: "component", key: "food_confirm", props: {}, ui } },
  };
}

// ===========================================================================
// PROPERTY 1 — CONFIRMED-X-COMMITTED-Y IS IMPOSSIBLE (the CRIT)
// ===========================================================================

describe("guardBeforeToolCall — commit-arg binding (CRIT)", () => {
  it("commits previewArgs ⊕ confirmedFields and DISCARDS the model's params", () => {
    const store = makeStore();
    const gov = makeGovernor(store);

    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: { food_name: "salmon", calories: 340 },
      editableFields: [
        { name: "food_name", type: "string" },
        { name: "calories", type: "number", constraints: { min: 0 } },
      ],
    });
    expect(store.stage("user_A", pending.pendingId, { calories: 350 })).toBe(true);

    const result = gov.guardBeforeToolCall(
      {
        toolName: "syntropy_log_food",
        params: { food_name: "HACKED", calories: 99999, pending_id: pending.pendingId },
      },
      "user_A",
    );

    // Model junk discarded; committed set is previewArgs overridden by the edit.
    expect(result).toEqual({ params: { food_name: "salmon", calories: 350 } });
    expect(result?.block).toBeUndefined();
    // pending_id never survives into the committed params.
    expect(result?.params).not.toHaveProperty("pending_id");
  });

  it("an override for a NON-editable field is dropped from the reconstructed params", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: { food_name: "salmon", calories: 340 },
      editableFields: [{ name: "calories", type: "number" }],
    });
    // Directly poke a non-editable override into the store (defence-in-depth path).
    store.stage("user_A", pending.pendingId, { calories: 350, food_name: "SNEAKY" });

    const result = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: pending.pendingId } },
      "user_A",
    );
    // food_name is not editable ⇒ stays the previewed value.
    expect(result).toEqual({ params: { food_name: "salmon", calories: 350 } });
  });
});

// ===========================================================================
// SEC-COLLISION (#1) — a collision-prefixed commit tool STILL gates
// ===========================================================================

describe("guardBeforeToolCall — collision-prefixed commit tool is still gated", () => {
  // Two servers whose commit tool name collides: the catalog surfaces the
  // second one prefixed as "<serverId>:<name>". The guard MUST recognise the
  // prefixed surfaced name as a commit tool (else it fails OPEN — the commit
  // runs ungated with model params, defeating the Governor).
  function twoServerGov(store: PendingConfirmStore) {
    return new ConfirmGovernor(store, {
      commitToolsByServer: new Map([
        ["kg", new Set(["syntropy_log_food"])],
        ["sj", new Set(["syntropy_log_food"])],
      ]),
      now,
    });
  }

  it("blocks a call to the PREFIXED commit tool with no pending", () => {
    const store = makeStore();
    const gov = twoServerGov(store);
    const result = gov.guardBeforeToolCall(
      { toolName: "sj:syntropy_log_food", params: { food_name: "salmon" } },
      "user_A",
    );
    expect(result?.block).toBe(true);
    expect(result?.params).toBeUndefined();
  });

  it("reconstructs a call to the PREFIXED commit tool with a valid staged pending", () => {
    const store = makeStore();
    const gov = twoServerGov(store);
    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "sj",
      commitTool: "syntropy_log_food",
      previewArgs: { food_name: "salmon", calories: 340 },
      editableFields: [{ name: "calories", type: "number" }],
    });
    expect(store.stage("user_A", pending.pendingId, { calories: 350 })).toBe(true);

    const result = gov.guardBeforeToolCall(
      {
        toolName: "sj:syntropy_log_food",
        params: { food_name: "HACKED", calories: 99999, pending_id: pending.pendingId },
      },
      "user_A",
    );
    expect(result).toEqual({ params: { food_name: "salmon", calories: 350 } });
    expect(result?.block).toBeUndefined();
  });
});

// ===========================================================================
// PROPERTY 2 — NO PENDING ⇒ BLOCK
// ===========================================================================

describe("guardBeforeToolCall — no valid pending is blocked", () => {
  it("blocks a commit call with no pending_id", () => {
    const gov = makeGovernor(makeStore());
    const result = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { food_name: "salmon" } },
      "user_A",
    );
    expect(result?.block).toBe(true);
    expect(result?.params).toBeUndefined();
  });

  it("blocks a hallucinated direct commit (pending_id references nothing)", () => {
    const gov = makeGovernor(makeStore());
    const result = gov.guardBeforeToolCall(
      {
        toolName: "syntropy_log_food",
        params: { food_name: "salmon", pending_id: "cnf_0000000000000000000000" },
      },
      "user_A",
    );
    expect(result?.block).toBe(true);
  });

  it("blocks when externalId is absent (no verified identity)", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: { calories: 1 },
      editableFields: [],
    });
    const result = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: pending.pendingId } },
      undefined,
    );
    expect(result?.block).toBe(true);
  });

  it("blocks when the pending belongs to a DIFFERENT commit tool", () => {
    const store = makeStore();
    const gov = makeGovernor(store, ["syntropy_log_food", "syntropy_delete_account"]);
    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: { calories: 1 },
      editableFields: [],
    });
    const result = gov.guardBeforeToolCall(
      { toolName: "syntropy_delete_account", params: { pending_id: pending.pendingId } },
      "user_A",
    );
    expect(result?.block).toBe(true);
  });

  it("does NOT gate a read (non-commit) tool", () => {
    const gov = makeGovernor(makeStore());
    const result = gov.guardBeforeToolCall(
      { toolName: "analyze_food", params: { food_name: "salmon" } },
      "user_A",
    );
    expect(result).toBeUndefined();
  });
});

// ===========================================================================
// PROPERTY 3 — REPLAY BLOCKED (single-use)
// ===========================================================================

describe("guardBeforeToolCall — replay is blocked", () => {
  it("consumes once; a second commit with the same pending_id is blocked", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: { calories: 340 },
      editableFields: [{ name: "calories", type: "number" }],
    });
    // Confirm-as-previewed (stages {}), so the guard has a completed confirm.
    store.stage("user_A", pending.pendingId, {});

    const first = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: pending.pendingId } },
      "user_A",
    );
    expect(first).toEqual({ params: { calories: 340 } });

    const replay = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: pending.pendingId } },
      "user_A",
    );
    expect(replay?.block).toBe(true);
  });
});

// ===========================================================================
// PROPERTY 4 — CROSS-USER BLOCKED
// ===========================================================================

describe("guardBeforeToolCall — cross-user isolation", () => {
  it("user_B cannot spend user_A's pending, and it survives for user_A", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: { calories: 340 },
      editableFields: [{ name: "calories", type: "number" }],
    });
    // Confirm-as-previewed (stages {}), so the rightful owner has a completed confirm.
    store.stage("user_A", pending.pendingId, {});

    const attacker = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: pending.pendingId } },
      "user_B",
    );
    expect(attacker?.block).toBe(true);

    // The rightful owner can still spend it (it was not consumed by the attacker).
    const owner = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: pending.pendingId } },
      "user_A",
    );
    expect(owner).toEqual({ params: { calories: 340 } });
  });
});

// ===========================================================================
// PROPERTY 5 — EDIT VALIDATION (parse rejects bad edits, nothing staged)
// ===========================================================================

describe("parseConfirmTurn — edit validation", () => {
  function mintEditable(store: PendingConfirmStore) {
    return store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: { calories: 340 },
      editableFields: [
        { name: "calories", type: "number", constraints: { min: 0, max: 5000 } },
        { name: "source", type: "string", constraints: { readOnly: true } },
      ],
    });
  }

  it("rejects an edit to a field not in editableFields — nothing staged", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = mintEditable(store);
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"protein":9}>`,
      "user_A",
    );
    expect(res.handled).toBe(true);
    expect(res.error).toBeTruthy();
    expect(store.consume("user_A", p.pendingId)?.confirmedFields).toBeUndefined();
  });

  it("rejects an out-of-constraint value (below min) — nothing staged", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = mintEditable(store);
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"calories":-5}>`,
      "user_A",
    );
    expect(res.handled).toBe(true);
    expect(res.error).toBeTruthy();
    expect(store.consume("user_A", p.pendingId)?.confirmedFields).toBeUndefined();
  });

  it("rejects an edit to a readOnly field — nothing staged", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = mintEditable(store);
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"source":"forged"}>`,
      "user_A",
    );
    expect(res.handled).toBe(true);
    expect(res.error).toBeTruthy();
    expect(store.consume("user_A", p.pendingId)?.confirmedFields).toBeUndefined();
  });

  it("stages a valid in-constraint edit", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = mintEditable(store);
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"calories":350}>`,
      "user_A",
    );
    expect(res).toEqual({ handled: true });
    expect(store.consume("user_A", p.pendingId)?.confirmedFields).toEqual({ calories: 350 });
  });

  it("stages an empty edit set (confirm-as-previewed)", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = mintEditable(store);
    const res = gov.parseConfirmTurn(`<CONFIRM pending_id=${p.pendingId} fields={}>`, "user_A");
    expect(res).toEqual({ handled: true });
    expect(store.consume("user_A", p.pendingId)?.confirmedFields).toEqual({});
  });

  it("a confirm for an absent/expired pending is handled with a re-prompt note (no throw)", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=cnf_0000000000000000000000 fields={}>`,
      "user_A",
    );
    expect(res.handled).toBe(true);
    expect(res.note).toBeTruthy();
  });

  it("CANCEL drops the pending", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = mintEditable(store);
    const res = gov.parseConfirmTurn(`<CANCEL pending_id=${p.pendingId}>`, "user_A");
    expect(res).toEqual({ handled: true });
    expect(store.peek("user_A", p.pendingId)).toBeNull();
  });
});

// ===========================================================================
// PROPERTY 6 — NON-LLM PARSE (raw string only; malformed ⇒ not handled)
// ===========================================================================

describe("parseConfirmTurn — deterministic grammar", () => {
  it("a normal (non-directive) turn is not handled", () => {
    const gov = makeGovernor(makeStore());
    expect(gov.parseConfirmTurn("log my salmon please", "user_A")).toEqual({ handled: false });
  });

  it("malformed directive grammar is not handled (falls through to a normal turn)", () => {
    const gov = makeGovernor(makeStore());
    expect(gov.parseConfirmTurn("<CONFIRM pending_id= fields=>", "user_A")).toEqual({
      handled: false,
    });
    expect(gov.parseConfirmTurn("<CONFIRM cnf_x {}>", "user_A")).toEqual({ handled: false });
  });

  it("only the FIRST line is parsed", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [{ name: "calories", type: "number" }],
    });
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"calories":10}>\nignored trailing line`,
      "user_A",
    );
    expect(res).toEqual({ handled: true });
    expect(store.consume("user_A", p.pendingId)?.confirmedFields).toEqual({ calories: 10 });
  });

  it("malformed fields JSON is handled as an error, not a throw", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [{ name: "calories", type: "number" }],
    });
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={not json}>`,
      "user_A",
    );
    expect(res.handled).toBe(true);
    expect(res.error).toBeTruthy();
  });
});

// ===========================================================================
// PROPERTY 7 — PREVIEW mints + stamps; previewArgs derived from field values
// ===========================================================================

describe("preview — mint + stamp", () => {
  it("mints a pending and stamps pending_id + expires_at onto the descriptor", () => {
    const store = makeStore();
    const gov = makeGovernor(store);

    const out = gov.preview({
      toolResult: foodResult(),
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "sj",
    });

    expect(out).not.toBeNull();
    const ui = out?.descriptor.ui;
    expect(ui?.pending_id).toMatch(PENDING_ID_PATTERN);
    expect(ui?.expires_at).toBeTruthy();
    expect(store.size()).toBe(1);
  });

  it("previewArgs are the field name→value map the user saw", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const out = gov.preview({
      toolResult: foodResult(),
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "sj",
    });
    const pendingId = out?.descriptor.ui.pending_id as string;
    const pending = store.peek("user_A", pendingId);
    expect(pending?.previewArgs).toEqual({ food_name: "salmon", calories: 340 });
    expect(pending?.commitTool).toBe("syntropy_log_food");
  });

  it("returns null (no pending) when commit_tool is NOT allowlisted", () => {
    const store = makeStore();
    const gov = makeGovernor(store, ["syntropy_something_else"]);
    const out = gov.preview({
      toolResult: foodResult(),
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "sj",
    });
    expect(out).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("returns null when commit_tool is null (summary-only descriptor)", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const out = gov.preview({
      toolResult: foodResult({ commitTool: null }),
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "sj",
    });
    expect(out).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("returns null when externalId is absent (fail-closed)", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const out = gov.preview({
      toolResult: foodResult(),
      externalId: undefined,
      sessionKey: "sess_A",
      serverId: "sj",
    });
    expect(out).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("returns null when the result carries no descriptor", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const out = gov.preview({
      toolResult: { content: [{ type: "text", text: "plain" }], details: { note: "no component" } },
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "sj",
    });
    expect(out).toBeNull();
  });

  it("does NOT round-trip a cross-server pending (server binding)", () => {
    // A pending minted on server "kg" must not be spent against the same-named
    // commit tool the catalog surfaced (prefixed) on server "sj".
    const store = makeStore();
    const gov = new ConfirmGovernor(store, {
      commitToolsByServer: new Map([
        ["kg", new Set(["syntropy_log_food"])],
        ["sj", new Set(["syntropy_log_food"])],
      ]),
      now,
    });
    const pending = store.mint({
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "kg",
      commitTool: "syntropy_log_food",
      previewArgs: { calories: 340 },
      editableFields: [],
    });
    store.stage("user_A", pending.pendingId, {});
    const result = gov.guardBeforeToolCall(
      { toolName: "sj:syntropy_log_food", params: { pending_id: pending.pendingId } },
      "user_A",
    );
    expect(result?.block).toBe(true);
  });

  it("the minted pending drives a full preview→confirm→commit round-trip", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const out = gov.preview({
      toolResult: foodResult(),
      externalId: "user_A",
      sessionKey: "sess_A",
      serverId: "sj",
    });
    const pendingId = out?.descriptor.ui.pending_id as string;

    const confirm = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${pendingId} fields={"calories":355}>`,
      "user_A",
    );
    expect(confirm).toEqual({ handled: true });

    const commit = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { food_name: "junk", pending_id: pendingId } },
      "user_A",
    );
    expect(commit).toEqual({ params: { food_name: "salmon", calories: 355 } });
  });
});

// ===========================================================================
// TEST-CONSTRAINTS — validateFieldValue per constraint (via parseConfirmTurn)
// ===========================================================================

describe("validateFieldValue — per-constraint accept/reject", () => {
  // Confirm a single field=value edit and report the staged result.
  function confirm(field: unknown, value: unknown) {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "s",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [field as never],
    });
    const name = (field as { name: string }).name;
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields=${JSON.stringify({ [name]: value })}>`,
      "user_A",
    );
    const staged = store.peek("user_A", p.pendingId)?.confirmedFields;
    return { res, staged };
  }
  const rejected = (r: { res: { error?: string }; staged?: unknown }) => {
    expect(r.res.error).toBeTruthy();
    expect(r.staged).toBeUndefined();
  };
  const accepted = (r: { res: { error?: string }; staged?: unknown }, expected: unknown) => {
    expect(r.res.error).toBeUndefined();
    expect(r.staged).toEqual(expected);
  };

  it("number min", () => {
    rejected(confirm({ name: "n", type: "number", constraints: { min: 0 } }, -1));
    accepted(confirm({ name: "n", type: "number", constraints: { min: 0 } }, 0), { n: 0 });
  });
  it("number max", () => {
    rejected(confirm({ name: "n", type: "number", constraints: { max: 10 } }, 11));
    accepted(confirm({ name: "n", type: "number", constraints: { max: 10 } }, 10), { n: 10 });
  });
  it("number step", () => {
    rejected(confirm({ name: "n", type: "number", constraints: { step: 5 } }, 7));
    accepted(confirm({ name: "n", type: "number", constraints: { step: 5 } }, 10), { n: 10 });
  });
  it("string maxLength", () => {
    rejected(confirm({ name: "s", type: "string", constraints: { maxLength: 3 } }, "abcd"));
    accepted(confirm({ name: "s", type: "string", constraints: { maxLength: 3 } }, "abc"), {
      s: "abc",
    });
  });
  it("string pattern", () => {
    rejected(confirm({ name: "s", type: "string", constraints: { pattern: "^a+$" } }, "b"));
    accepted(confirm({ name: "s", type: "string", constraints: { pattern: "^a+$" } }, "aaa"), {
      s: "aaa",
    });
  });
  it("options (string)", () => {
    rejected(confirm({ name: "s", type: "string", constraints: { options: ["x", "y"] } }, "z"));
    accepted(confirm({ name: "s", type: "string", constraints: { options: ["x", "y"] } }, "x"), {
      s: "x",
    });
  });
  it("integer", () => {
    rejected(confirm({ name: "n", type: "integer" }, 1.5));
    accepted(confirm({ name: "n", type: "integer" }, 2), { n: 2 });
  });
  it("boolean type guard", () => {
    rejected(confirm({ name: "b", type: "boolean" }, "true"));
    accepted(confirm({ name: "b", type: "boolean" }, true), { b: true });
  });
  it("enum options", () => {
    rejected(confirm({ name: "e", type: "enum", constraints: { options: ["a", "b"] } }, "c"));
    accepted(confirm({ name: "e", type: "enum", constraints: { options: ["a", "b"] } }, "a"), {
      e: "a",
    });
  });
  it("photo cannot be edited", () => {
    rejected(confirm({ name: "p", type: "photo" }, "data:image/png;base64,AAAA"));
  });
});

// ===========================================================================
// SEC-REDOS (#4) — backend-controlled pattern is bounded before compile/test
// ===========================================================================

describe("validateFieldValue — ReDoS caps", () => {
  function confirmString(constraints: Record<string, unknown>, value: string) {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "s",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [{ name: "note", type: "string", constraints } as never],
    });
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields=${JSON.stringify({ note: value })}>`,
      "user_A",
    );
    return { res, staged: store.peek("user_A", p.pendingId)?.confirmedFields };
  }

  it("rejects an over-long pattern (>512) as a validation error", () => {
    const r = confirmString({ pattern: "a".repeat(600) }, "aaa");
    expect(r.res.error).toBeTruthy();
    expect(r.staged).toBeUndefined();
  });

  it("rejects an over-long value (>4096) before testing the pattern", () => {
    const r = confirmString({ pattern: "^a+$" }, "a".repeat(5000));
    expect(r.res.error).toBeTruthy();
    expect(r.staged).toBeUndefined();
  });
});

// ===========================================================================
// TEST-PROTO — prototype-pollution keys are not editable, nothing staged
// ===========================================================================

describe("parseConfirmTurn — prototype-pollution keys rejected", () => {
  it("rejects __proto__ and constructor edits; Object.prototype unpolluted", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "s",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [{ name: "calories", type: "number" }],
    });
    const proto = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"__proto__":{"polluted":true}}>`,
      "user_A",
    );
    expect(proto.error).toBeTruthy();
    const ctor = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"constructor":{"x":1}}>`,
      "user_A",
    );
    expect(ctor.error).toBeTruthy();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(store.peek("user_A", p.pendingId)?.confirmedFields).toBeUndefined();
  });
});

// ===========================================================================
// TEST-EXPIRY-GUARD — a commit past expiry is blocked
// ===========================================================================

describe("guardBeforeToolCall — expiry", () => {
  it("blocks a commit whose pending has expired", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "s",
      commitTool: "syntropy_log_food",
      previewArgs: { calories: 1 },
      editableFields: [],
    });
    store.stage("user_A", p.pendingId, {});
    nowMs = p.expiresAtMs + 1; // advance past expiry
    const result = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: p.pendingId } },
      "user_A",
    );
    expect(result?.block).toBe(true);
  });
});

// ===========================================================================
// TEST-NOEXTID-PARSE / TEST-XUSER-PARSE — confirm-parse identity failures
// ===========================================================================

describe("parseConfirmTurn — identity failures", () => {
  it("TEST-NOEXTID-PARSE: undefined externalId ⇒ handled + error, store unchanged", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const before = store.size();
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=cnf_0000000000000000000000 fields={}>`,
      undefined,
    );
    expect(res.handled).toBe(true);
    expect(res.error).toBeTruthy();
    expect(store.size()).toBe(before);
  });

  it("TEST-XUSER-PARSE: userB cannot stage onto userA's pending", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "userA",
      sessionKey: "s",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [{ name: "calories", type: "number" }],
    });
    const res = gov.parseConfirmTurn(
      `<CONFIRM pending_id=${p.pendingId} fields={"calories":10}>`,
      "userB",
    );
    expect(res.handled).toBe(true);
    expect(res.note).toBeTruthy();
    // userA's pending was never staged.
    expect(store.consume("userA", p.pendingId)?.confirmedFields).toBeUndefined();
  });
});

// ===========================================================================
// TEST-BLOCKREASON — block results carry a non-empty, non-leaking reason
// ===========================================================================

describe("guardBeforeToolCall — block reason", () => {
  it("a block carries a non-empty reason that does not leak the pending id", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "s",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [],
    });
    const result = gov.guardBeforeToolCall(
      { toolName: "syntropy_log_food", params: { pending_id: p.pendingId } },
      "user_B", // wrong owner ⇒ block
    );
    expect(result?.block).toBe(true);
    expect(typeof result?.blockReason).toBe("string");
    expect(result?.blockReason?.length).toBeGreaterThan(0);
    expect(result?.blockReason).not.toContain(p.pendingId);
  });
});

// ===========================================================================
// CODE-FIRSTLINE — the directive is matched on the first NON-EMPTY line
// ===========================================================================

describe("parseConfirmTurn — first non-empty line", () => {
  it("recognises a confirm after leading blank lines", () => {
    const store = makeStore();
    const gov = makeGovernor(store);
    const p = store.mint({
      externalId: "user_A",
      sessionKey: "s",
      commitTool: "syntropy_log_food",
      previewArgs: {},
      editableFields: [{ name: "calories", type: "number" }],
    });
    const res = gov.parseConfirmTurn(
      `\n   \n<CONFIRM pending_id=${p.pendingId} fields={"calories":12}>`,
      "user_A",
    );
    expect(res).toEqual({ handled: true });
    expect(store.consume("user_A", p.pendingId)?.confirmedFields).toEqual({ calories: 12 });
  });
});
