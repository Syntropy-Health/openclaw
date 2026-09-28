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
 *   repo  Syntropy-Health/shrinemobile, landed on main via PR #73
 *         (merge 56353b98beabebf7138cbdf8aa9b6f102ab7775d; PR head 1a5074f7b27b)
 *   file  lib/features/synth_notes/domain/confirm_directive.dart
 *     line numbers as of 56353b98:
 *     :31  '<CONFIRM pending_id=$pendingId fields=${jsonEncode(const <String, Object?>{})}>'
 *     :36  '<CANCEL pending_id=$pendingId>'
 *   Dart jsonEncode of an empty const map is the two bytes "{}".
 * If the client template changes, update BOTH the Dart and the constants below
 * in the same change; if the GRAMMAR changes, this suite names the string that
 * stopped parsing — fix the client or the grammar, never loosen this assertion.
 *
 * Scope limit, stated so a green run is not over-read: this pins parseConfirmTurn
 * itself, NOT the hook boundary (index.ts passes `event.prompt`). Whether every
 * transport delivers the client's bytes unwrapped to that hook is a separate
 * question this file does not answer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PENDING_ID_PATTERN } from "../../../src/gateway/component-descriptor.schema.js";
import { ConfirmGovernor } from "./governor.js";
import { PendingConfirmStore } from "./pending-confirm-store.js";

/** Client wire templates; `__ID__` stands for the Dart `$pendingId` interpolation. */
const CLIENT_CONFIRM_WIRE = "<CONFIRM pending_id=__ID__ fields={}>";
const CLIENT_CANCEL_WIRE = "<CANCEL pending_id=__ID__>";

/**
 * Real pending ids are `cnf_` + base64url, so ~29% of them contain `-`. A fixed
 * id carrying BOTH `-` and `_` in the random part (and a leading `-`) means a
 * grammar narrowed from `(\S+)` to `(\w+)` fails here instead of in production.
 */
const REALISTIC_ID = "cnf_-Ab_Cd-Ef_Gh-Ij_Kl-Mn_";

function wire(template: string, pendingId: string): string {
  const bytes = template.replace("__ID__", pendingId);
  // Fixture self-check: a template edit that drops the placeholder must fail
  // HERE, naming the fixture, not later as a misleading "stopped parsing".
  expect(bytes, `fixture: template lost its __ID__ placeholder: ${template}`).toContain(pendingId);
  expect(bytes).not.toContain("__ID__");
  return bytes;
}

let nowMs: number;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

function setup() {
  const store = new PendingConfirmStore({ now, ttlSeconds: 300, randomId: () => REALISTIC_ID });
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
  it("fixture id is a production-shaped id: matches the gateway PENDING_ID_PATTERN and carries '-'", () => {
    const { pendingId } = setup();
    expect(pendingId).toBe(REALISTIC_ID);
    expect(pendingId).toMatch(PENDING_ID_PATTERN);
    expect(pendingId).toMatch(/-/);
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

  it("differential control: the client CONFIRM bytes with ONE token changed (fields={} -> fields=[]) do not stage", () => {
    const { store, gov, pendingId } = setup();
    const bytes = wire(CLIENT_CONFIRM_WIRE, pendingId).replace("fields={}", "fields=[]");
    gov.parseConfirmTurn(bytes, "user_A");
    expect(store.peek("user_A", pendingId)?.confirmedFields).toBeUndefined();
  });

  it("control: a non-directive turn is not handled and leaves the pending untouched", () => {
    const { store, gov, pendingId } = setup();
    expect(gov.parseConfirmTurn("log my salmon please", "user_A")).toEqual({ handled: false });
    expect(store.peek("user_A", pendingId)).not.toBeNull();
  });

  it("cross-user: another user's client CANCEL bytes do not drop user_A's pending", () => {
    const { store, gov, pendingId } = setup();
    gov.parseConfirmTurn(wire(CLIENT_CANCEL_WIRE, pendingId), "user_B");
    expect(store.peek("user_A", pendingId)).not.toBeNull();
  });

  it("cross-user: another user's client CONFIRM bytes do not stage user_A's pending", () => {
    const { store, gov, pendingId } = setup();
    gov.parseConfirmTurn(wire(CLIENT_CONFIRM_WIRE, pendingId), "user_B");
    expect(store.peek("user_A", pendingId)?.confirmedFields).toBeUndefined();
  });
});
