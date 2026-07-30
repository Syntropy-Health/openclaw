import { describe, expect, it } from "vitest";
import {
  buildAdminGateContext,
  buildUserGateContext,
  computePhiCleared,
  envFlagEnabled,
  normalizeSubscriptionPlan,
  subscriptionRank,
  type GateContext,
} from "./gate-context.js";
import {
  DEFAULT_GATE,
  evaluateGate,
  gateRequiresPhiAudit,
  parseGate,
  type Gate,
} from "./tool-gate.js";

// ── GateContext builders + StrictBool discipline (ADR-0001, devex PIN 2) ──────
describe("gate-context — StrictBool + phi conjunction", () => {
  it("computePhiCleared is a real-boolean AND (both true → true)", () => {
    expect(computePhiCleared(true, true)).toBe(true);
  });
  it("computePhiCleared fail-closes on either false", () => {
    expect(computePhiCleared(false, true)).toBe(false);
    expect(computePhiCleared(true, false)).toBe(false);
    expect(computePhiCleared(false, false)).toBe(false);
  });
  it("computePhiCleared REJECTS a truthy non-boolean key claim (=== true)", () => {
    // StrictBool trap: a stringified/numeric 'true' must NOT mint clearance.
    expect(computePhiCleared("true", true)).toBe(false);
    expect(computePhiCleared(1, true)).toBe(false);
    expect(computePhiCleared("1", true)).toBe(false);
  });
  it("envFlagEnabled coerces the GRAPHITI_PHI_ENABLED env string strictly", () => {
    expect(envFlagEnabled("true")).toBe(true);
    expect(envFlagEnabled("TRUE")).toBe(true);
    expect(envFlagEnabled(" 1 ")).toBe(true);
    expect(envFlagEnabled("false")).toBe(false);
    expect(envFlagEnabled("0")).toBe(false);
    expect(envFlagEnabled("")).toBe(false);
    expect(envFlagEnabled(undefined)).toBe(false);
    expect(envFlagEnabled("yes")).toBe(false);
  });
  it("normalizeSubscriptionPlan fail-closes unknown → anon (lowest)", () => {
    expect(normalizeSubscriptionPlan("pro")).toBe("pro");
    expect(normalizeSubscriptionPlan("enterprise")).toBe("anon");
    expect(normalizeSubscriptionPlan(undefined)).toBe("anon");
    expect(subscriptionRank("anon")).toBeLessThan(subscriptionRank("max"));
  });

  it("buildUserGateContext is NOT admin by construction (WhatsApp/partner path)", () => {
    const ctx = buildUserGateContext({ externalId: "user_123", subscriptionPlan: "pro" });
    expect(ctx.is_admin).toBe(false);
    expect(ctx.admin_subject).toBeUndefined();
    expect(ctx.phi_cleared).toBe(false);
    expect(ctx.is_authenticated).toBe(true);
    expect(ctx.user_subject).toBe("user_123");
  });
  it("buildUserGateContext with no externalId → unauthenticated", () => {
    const ctx = buildUserGateContext({ externalId: undefined });
    expect(ctx.is_authenticated).toBe(false);
    expect(ctx.is_admin).toBe(false);
  });

  it("buildAdminGateContext derives admin identity from the KEY, phi_cleared = conjunction", () => {
    const ctx = buildAdminGateContext({
      admin: { adminSubject: "user_admin", phiClearance: true },
      graphitiPhiEnabled: true,
      subscriptionPlan: "max",
    });
    expect(ctx.is_admin).toBe(true);
    expect(ctx.admin_subject).toBe("user_admin");
    expect(ctx.phi_cleared).toBe(true);
  });
  it("buildAdminGateContext: phi clearance WITHOUT platform BAA → phi_cleared false", () => {
    const ctx = buildAdminGateContext({
      admin: { adminSubject: "user_admin", phiClearance: true },
      graphitiPhiEnabled: false, // BAA not flipped
    });
    expect(ctx.is_admin).toBe(true);
    expect(ctx.phi_cleared).toBe(false); // conjunction fail-closed
  });

  // User own-PHI flip (CTO #5334 ruling, cleared by SJ self-scoping rail #5339/#1624).
  it("buildUserGateContext: signed-in user + platform BAA → phi_cleared true (own PHI)", () => {
    const ctx = buildUserGateContext({ externalId: "user_x", graphitiPhiEnabled: true });
    expect(ctx.is_admin).toBe(false); // still never admin
    expect(ctx.phi_cleared).toBe(true);
  });
  it("buildUserGateContext: user without BAA → phi_cleared false (fail-closed)", () => {
    expect(
      buildUserGateContext({ externalId: "user_x", graphitiPhiEnabled: false }).phi_cleared,
    ).toBe(false);
    expect(buildUserGateContext({ externalId: "user_x" }).phi_cleared).toBe(false); // omitted → false
  });
  it("buildUserGateContext: anon (no externalId) + BAA → phi_cleared false (must be signed in)", () => {
    expect(
      buildUserGateContext({ externalId: undefined, graphitiPhiEnabled: true }).phi_cleared,
    ).toBe(false);
  });
});

describe("evaluateGate — user own-PHI path (all_of[auth_required, phi])", () => {
  const g: Gate = {
    kind: "composite",
    op: "all_of",
    members: [{ kind: "auth_required" }, { kind: "phi" }],
  };
  it("signed-in user + BAA → allowed (their own self-scoped PHI)", () => {
    const ctx = buildUserGateContext({ externalId: "u", graphitiPhiEnabled: true });
    expect(evaluateGate(g, ctx).allowed).toBe(true);
  });
  it("signed-in user WITHOUT BAA → denied at the phi leg", () => {
    const ctx = buildUserGateContext({ externalId: "u", graphitiPhiEnabled: false });
    const d = evaluateGate(g, ctx);
    expect(d.allowed).toBe(false);
    expect(d.failing_kind).toBe("phi");
  });
});

// ── evaluator (mirror of SJ evaluate_decision) ────────────────────────────────
const userCtx: GateContext = buildUserGateContext({ externalId: "u1", subscriptionPlan: "free" });
const anonCtx: GateContext = buildUserGateContext({ externalId: undefined });
const adminCtx: GateContext = buildAdminGateContext({
  admin: { adminSubject: "a1", phiClearance: true },
  graphitiPhiEnabled: true,
  subscriptionPlan: "max",
});
const adminNoPhiCtx: GateContext = buildAdminGateContext({
  admin: { adminSubject: "a1", phiClearance: false },
  graphitiPhiEnabled: true,
});

describe("evaluateGate — per gate-kind", () => {
  it("auth_required: authed allow, anon deny", () => {
    expect(evaluateGate({ kind: "auth_required" }, userCtx).allowed).toBe(true);
    const d = evaluateGate({ kind: "auth_required" }, anonCtx);
    expect(d.allowed).toBe(false);
    expect(d.failing_kind).toBe("auth_required");
  });

  it("admin_required: admin allow, user DENY (the F1/user-scoped boundary)", () => {
    expect(evaluateGate({ kind: "admin_required" }, adminCtx).allowed).toBe(true);
    const d = evaluateGate({ kind: "admin_required" }, userCtx);
    expect(d.allowed).toBe(false);
    expect(d.failing_kind).toBe("admin_required");
  });

  it("phi: allowed only when phi_cleared; admin-without-clearance denied", () => {
    expect(evaluateGate({ kind: "phi" }, adminCtx).allowed).toBe(true);
    expect(evaluateGate({ kind: "phi" }, adminNoPhiCtx).allowed).toBe(false);
    expect(evaluateGate({ kind: "phi" }, userCtx).allowed).toBe(false);
  });

  it("subscription: tier gate by rank", () => {
    expect(evaluateGate({ kind: "subscription", min_tier: "free" }, userCtx).allowed).toBe(true);
    expect(evaluateGate({ kind: "subscription", min_tier: "pro" }, userCtx).allowed).toBe(false);
    expect(evaluateGate({ kind: "subscription", min_tier: "max" }, adminCtx).allowed).toBe(true);
  });

  it("composite all_of: admin_required AND phi (admin+PHI path)", () => {
    const g: Gate = {
      kind: "composite",
      op: "all_of",
      members: [{ kind: "admin_required" }, { kind: "phi" }],
    };
    expect(evaluateGate(g, adminCtx).allowed).toBe(true);
    expect(evaluateGate(g, adminNoPhiCtx).allowed).toBe(false); // phi leg fails
    expect(evaluateGate(g, userCtx).failing_kind).toBe("admin_required"); // first failing leg
  });

  it("composite any_of: SECURITY RAIL — an any_of containing phi/admin_required DENIES (no OR-weakening)", () => {
    const weaken: Gate = {
      kind: "composite",
      op: "any_of",
      members: [{ kind: "auth_required" }, { kind: "admin_required" }],
    };
    // Even an admin must be denied — the gate itself is malformed, fail-closed.
    expect(evaluateGate(weaken, adminCtx).allowed).toBe(false);
    expect(evaluateGate(weaken, adminCtx).failing_kind).toBe("composite");
  });

  it("composite any_of (non-privileged): satisfied by any member", () => {
    const g: Gate = {
      kind: "composite",
      op: "any_of",
      members: [{ kind: "subscription", min_tier: "pro" }, { kind: "auth_required" }],
    };
    expect(evaluateGate(g, userCtx).allowed).toBe(true); // auth leg
    expect(evaluateGate(g, anonCtx).allowed).toBe(false); // neither
  });

  it("empty any_of never satisfies (fail-closed)", () => {
    expect(evaluateGate({ kind: "composite", op: "any_of", members: [] }, adminCtx).allowed).toBe(
      false,
    );
  });
});

describe("gateRequiresPhiAudit", () => {
  it("true for a phi gate and any composite containing one", () => {
    expect(gateRequiresPhiAudit({ kind: "phi" })).toBe(true);
    expect(
      gateRequiresPhiAudit({
        kind: "composite",
        op: "all_of",
        members: [{ kind: "admin_required" }, { kind: "phi" }],
      }),
    ).toBe(true);
  });
  it("false for non-phi gates", () => {
    expect(gateRequiresPhiAudit({ kind: "admin_required" })).toBe(false);
    expect(gateRequiresPhiAudit(DEFAULT_GATE)).toBe(false);
  });
});

describe("parseGate — fail-closed", () => {
  it("parses the known kinds", () => {
    expect(parseGate({ kind: "auth_required" })).toEqual({ kind: "auth_required" });
    expect(parseGate({ kind: "admin_required" })).toEqual({ kind: "admin_required" });
    expect(parseGate({ kind: "phi" })).toEqual({ kind: "phi" });
    expect(parseGate({ kind: "subscription", min_tier: "pro" })).toEqual({
      kind: "subscription",
      min_tier: "pro",
    });
  });
  it("parses a valid composite recursively", () => {
    const g = parseGate({
      kind: "composite",
      op: "all_of",
      members: [{ kind: "admin_required" }, { kind: "phi" }],
    });
    expect(g).toEqual({
      kind: "composite",
      op: "all_of",
      members: [{ kind: "admin_required" }, { kind: "phi" }],
    });
  });
  it("returns null (→ guard DENIES) for malformed / unknown / poisoned input", () => {
    expect(parseGate(null)).toBeNull();
    expect(parseGate("phi")).toBeNull();
    expect(parseGate({ kind: "wat" })).toBeNull();
    expect(parseGate({ kind: "subscription", min_tier: "enterprise" })).toBeNull();
    expect(parseGate({ kind: "composite", op: "xor", members: [] })).toBeNull();
    expect(parseGate({ kind: "composite", op: "all_of", members: [{ kind: "bogus" }] })).toBeNull();
  });
});
