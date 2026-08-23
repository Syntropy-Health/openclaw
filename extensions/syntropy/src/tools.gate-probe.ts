/**
 * P3-A4 — COMPILE-GATE ATTENDANCE PROBE: the #200 membership gate, asserted
 * ARMED (CTO-approved seam assertion, dispatch #7001).
 *
 * WHY: the gate's mutation proofs were executed in-session during #200's QG —
 * a mutation proof executed in a terminal is EVIDENCE the gate worked that
 * day, not an ASSERTION that it still does. The bypass nothing else watches
 * is GATE-REMOVAL by type-widening: change `TOOL_LOCALS` to
 * `Record<string, ToolLocal>`, or let the roster's `name` widen to `string`
 * (the exact regression #200's QG caught once already) — every runtime test
 * stays green while all future protection silently disappears.
 *
 * MECHANISM: each alias below is a positive constraint that TYPE-CHECKS while
 * the gate is armed and becomes a COMPILE ERROR the moment it widens — so
 * `pnpm check` (tsgo, CI at ci.yml:270) goes red on the widening itself, not
 * on some later drift it would have caught. Types-only: no runtime emit,
 * nothing imports this file; tsgo checks it because it is in the project.
 *
 * If one of these fires and you are SURE the change is intended, you are
 * disarming a security-adjacent contract gate — say so in the PR in those
 * words, and update this probe in the same commit.
 */

import type { RosterToolName } from "./generated/tool-roster.generated.js";
import type { ToolLocalsShape } from "./tools.js";

type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;

// ---------------------------------------------------------------------------
// PROBE 1 — the roster's name union is LITERAL, not string.
// Historical bypass: a `: ToolDef[]` annotation widened `name` to `string`
// and silently defeated both membership gates (#200 QG). If regeneration or
// a refactor widens `RosterToolName`, `string extends RosterToolName`
// becomes true and this alias errors.
// ---------------------------------------------------------------------------

type _RosterUnionIsLiteral = AssertFalse<string extends RosterToolName ? true : false>;

// ---------------------------------------------------------------------------
// PROBE 2 — the gate rejects an under-specified map (#200 mutant M1's class).
// While armed, `ToolLocalsShape` has REQUIRED literal keys, so `{}` is not
// assignable. Widened to `Record<string, ToolLocal>`, `{}` satisfies the
// index signature, the conditional flips true, and this alias errors.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type _EmptyMapRejected = AssertFalse<{} extends ToolLocalsShape ? true : false>;

// ---------------------------------------------------------------------------
// PROBE 3 — the gate's key set is EXACTLY roster-bounded (#200 mutant M2's
// class). (a) every key is a rostered name — a phantom key in the declared
// type errors here; (b) there is NO string index signature — the widening
// that would readmit phantoms at assignment sites.
// ---------------------------------------------------------------------------

type _KeysAreRostered = AssertTrue<
  Exclude<keyof ToolLocalsShape, RosterToolName> extends never ? true : false
>;
type _NoIndexSignature = AssertFalse<string extends keyof ToolLocalsShape ? true : false>;

export {};
