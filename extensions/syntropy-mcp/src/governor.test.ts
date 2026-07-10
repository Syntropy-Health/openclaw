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
