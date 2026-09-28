/**
 * PRODUCER-SIDE GRAMMAR PIN — the Confirm Governor must parse the EXACT bytes
 * the shrinemobile client sends.
 *
 * Why this file exists (CTO #12168, seam-defect rail): shrinemobile pins the
 * CONFIRM_RE / CANCEL_RE regex LITERALS textually, so it cannot see a SEMANTIC
 * change to parseConfirmTurn (e.g. a first-line/trim/order change that keeps the
 * literal but stops handling the client's string). Only a test on the producer
 * side that consumes the consumer's bytes closes that seam.
 *
 * Source of the wire templates — copied VERBATIM, do not "tidy":
 *   repo  Syntropy-Health/shrinemobile, PR #73, tip 1a5074f7b27b8994012c49ce7e2ce33725f962dc
 *   file  lib/features/synth_notes/domain/confirm_directive.dart
 *     :31  '<CONFIRM pending_id=$pendingId fields=${jsonEncode(const <String, Object?>{})}>'
 *     :36  '<CANCEL pending_id=$pendingId>'
 *   Dart jsonEncode of an empty const map is the two bytes "{}".
 * If the client template changes, update BOTH the Dart and the constants below
 * in the same change; if the GRAMMAR changes, this suite names the string that
 * stopped parsing — fix the client or the grammar, never loosen this assertion.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PENDING_ID_PATTERN } from "../../../src/gateway/component-descriptor.schema.js";
import { ConfirmGovernor } from "./governor.js";
import { PendingConfirmStore } from "./pending-confirm-store.js";

/** Client wire templates; `__ID__` stands for the Dart `$pendingId` interpolation. */
const CLIENT_CONFIRM_WIRE = "<CONFIRM pending_id=__ID__ fields={}>";
const CLIENT_CANCEL_WIRE = "<CANCEL pending_id=__ID__>";

const wire = (template: string, pendingId: string) => template.replace("__ID__", pendingId);

let nowMs: number;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

function seqRandomId(): () => string {
  let n = 0;
  return () => `cnf_${String(n++).padStart(22, "0")}`;
}

function setup() {
  const store = new PendingConfirmStore({ now, ttlSeconds: 300, randomId: seqRandomId() });
  const gov = new ConfirmGovernor(store, {
    onDrop: () => {},
    commitToolsByServer: new Map([["sj", new Set(["syntropy_log_food"])]]),
    navToolsByServer: new Map(),
    now,
  });
  const pending = store.mint({
    externalId: "user_A",
    sessionKey: "sess_A",
    commitTool: "syntropy_log_food",
    previewArgs: { food_name: "salmon", calories: 340 },
    editableFields: [{ name: "calories", type: "number", constraints: { min: 0 } }],
  });
  return { store, gov, pendingId: pending.pendingId };
}

describe("parseConfirmTurn — shrinemobile client wire bytes (PR #73)", () => {
  it("the fixture pending id is one the client would accept (cnf_ pattern)", () => {
    const { pendingId } = setup();
    expect(pendingId).toMatch(PENDING_ID_PATTERN);
  });

  it("handles the client's exact CONFIRM bytes and stages the pending as-previewed", () => {
    const { store, gov, pendingId } = setup();
    const bytes = wire(CLIENT_CONFIRM_WIRE, pendingId);
    const res = gov.parseConfirmTurn(bytes, "user_A");
    expect(res, `client CONFIRM wire stopped parsing: ${JSON.stringify(bytes)}`).toEqual({
      handled: true,
    });
    expect(store.consume("user_A", pendingId)?.confirmedFields).toEqual({});
  });

  it("handles the client's exact CANCEL bytes and drops the pending", () => {
    const { store, gov, pendingId } = setup();
    const bytes = wire(CLIENT_CANCEL_WIRE, pendingId);
    const res = gov.parseConfirmTurn(bytes, "user_A");
    expect(res, `client CANCEL wire stopped parsing: ${JSON.stringify(bytes)}`).toEqual({
      handled: true,
    });
    expect(store.peek("user_A", pendingId)).toBeNull();
  });

  it("control: a non-directive turn from the same user is NOT handled (the pin can fail)", () => {
    const { store, gov, pendingId } = setup();
    expect(gov.parseConfirmTurn("log my salmon please", "user_A")).toEqual({ handled: false });
    expect(store.peek("user_A", pendingId)).not.toBeNull();
  });
});
