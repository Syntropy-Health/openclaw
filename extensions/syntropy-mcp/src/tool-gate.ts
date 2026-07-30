/**
 * Tool-gate evaluator — the openclaw-side mirror of SJ's `evaluate_decision`
 * (ADR-0001, SJ PR #1622). Given a tool's declared gate + the built
 * {@link GateContext}, decide allow/deny at dispatch. This is the CLIENT leg of a
 * defense-in-depth pair: SJ re-evaluates server-side (CTO #5324), so this must
 * match SJ's semantics but is never the sole gatekeeper.
 *
 * Fail-closed everywhere: an ABSENT gate defaults to `auth_required` (the ADR
 * minimum — never infer admin/phi); a MALFORMED/unknown gate DENIES; an `any_of`
 * that could OR-away a `phi`/`admin_required` requirement DENIES (you cannot
 * weaken a privileged requirement through a composite).
 */

import type { GateContext } from "./gate-context.js";
import { subscriptionRank, type SubscriptionPlan } from "./gate-context.js";

export type GateKind = "auth_required" | "admin_required" | "phi" | "subscription" | "composite";

export type Gate =
  | { kind: "auth_required" }
  | { kind: "admin_required" }
  | { kind: "phi" }
  | { kind: "subscription"; min_tier: SubscriptionPlan }
  | { kind: "composite"; op: "all_of" | "any_of"; members: Gate[] };

/** The ADR minimum for a tool with no declared gate — signed-in required, never admin/phi. */
export const DEFAULT_GATE: Gate = { kind: "auth_required" };

export type GateDecision = {
  allowed: boolean;
  /** The gate-kind that failed (for the denial reason + audit). Omitted when allowed. */
  failing_kind?: GateKind;
};

const PLAN_VALUES: readonly SubscriptionPlan[] = ["anon", "free", "pro", "max"];

/** A privileged leaf that must NEVER be reachable via an `any_of` (weakening) branch. */
function containsPrivileged(gate: Gate): boolean {
  switch (gate.kind) {
    case "phi":
    case "admin_required":
      return true;
    case "composite":
      return gate.members.some(containsPrivileged);
    default:
      return false;
  }
}

/**
 * Evaluate a gate against the context. Pure; deterministic; matches SJ.
 * `phi` allows iff `ctx.phi_cleared` (which already = `meta.phi_clearance AND
 * GRAPHITI_PHI_ENABLED`); SJ additionally re-checks `is_personal_health_context`
 * + `GRAPHITI_PHI_ENABLED` server-side (leg 2). The audit write (see the guard) is
 * a SEPARATE hard gate, not part of allow/deny.
 */
export function evaluateGate(gate: Gate, ctx: GateContext): GateDecision {
  switch (gate.kind) {
    case "auth_required":
      return ctx.is_authenticated
        ? { allowed: true }
        : { allowed: false, failing_kind: "auth_required" };

    case "admin_required":
      // Real boolean by construction; `=== true` rejects any non-bool leak.
      return ctx.is_admin === true
        ? { allowed: true }
        : { allowed: false, failing_kind: "admin_required" };

    case "phi":
      return ctx.phi_cleared === true ? { allowed: true } : { allowed: false, failing_kind: "phi" };

    case "subscription":
      return subscriptionRank(ctx.subscription_plan) >= subscriptionRank(gate.min_tier)
        ? { allowed: true }
        : { allowed: false, failing_kind: "subscription" };

    case "composite": {
      if (gate.op === "any_of") {
        // Security rail (SJ pin): an any_of MUST NOT contain a phi/admin_required
        // descendant — that would let a weaker OR-branch bypass a privileged
        // requirement. Such a gate is malformed → DENY.
        if (gate.members.some(containsPrivileged)) {
          return { allowed: false, failing_kind: "composite" };
        }
        if (gate.members.length === 0) {
          return { allowed: false, failing_kind: "composite" }; // empty any_of never satisfies
        }
        for (const m of gate.members) {
          if (evaluateGate(m, ctx).allowed) {
            return { allowed: true };
          }
        }
        return { allowed: false, failing_kind: "composite" };
      }
      // all_of: every member must allow; surface the first failing kind.
      for (const m of gate.members) {
        const d = evaluateGate(m, ctx);
        if (!d.allowed) {
          return { allowed: false, failing_kind: d.failing_kind ?? "composite" };
        }
      }
      return { allowed: true };
    }
  }
}

/** True iff this gate (or a descendant) is a `phi` gate — the guard uses this to decide whether an audit write is required before allowing. */
export function gateRequiresPhiAudit(gate: Gate): boolean {
  if (gate.kind === "phi") {
    return true;
  }
  if (gate.kind === "composite") {
    return gate.members.some(gateRequiresPhiAudit);
  }
  return false;
}

/**
 * Parse a tools/list gate annotation (arbitrary JSON) into a validated {@link Gate}.
 * Fail-closed: anything not recognized returns `null` → the guard treats a null
 * (malformed) gate as DENY, and an ABSENT annotation (never passed here) as
 * {@link DEFAULT_GATE}. We never coerce an unknown shape into a permissive gate.
 */
export function parseGate(raw: unknown): Gate | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const kind = (raw as { kind?: unknown }).kind;
  switch (kind) {
    case "auth_required":
    case "admin_required":
    case "phi":
      return { kind };
    case "subscription": {
      const tier = (raw as { min_tier?: unknown }).min_tier;
      if (typeof tier === "string" && (PLAN_VALUES as readonly string[]).includes(tier)) {
        return { kind: "subscription", min_tier: tier as SubscriptionPlan };
      }
      return null;
    }
    case "composite": {
      const op = (raw as { op?: unknown }).op;
      const rawMembers = (raw as { members?: unknown }).members;
      if ((op !== "all_of" && op !== "any_of") || !Array.isArray(rawMembers)) {
        return null;
      }
      const members: Gate[] = [];
      for (const m of rawMembers) {
        const parsed = parseGate(m);
        if (!parsed) {
          return null; // one bad member poisons the whole composite (fail-closed)
        }
        members.push(parsed);
      }
      return { kind: "composite", op, members };
    }
    default:
      return null;
  }
}
