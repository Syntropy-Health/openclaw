/**
 * GateContext — the openclaw-side mirror of SJ's frozen `GateContext`
 * (ADR-0001, SJ PR #1622 on origin/test). openclaw BUILDS this per turn and both
 * (a) evaluates gates at dispatch against it and (b) sends it to SJ as a JSON
 * body for the server-side `evaluate_decision` re-check (defense-in-depth, CTO
 * #5324 — openclaw is never the sole gatekeeper).
 *
 * StrictBool discipline: `is_admin` and `phi_cleared` MUST be REAL booleans. SJ's
 * Pydantic `StrictBool` rejects a stringified/numeric bool loudly (the
 * name-collision rail) — so we coerce to a real `boolean` at the point we build
 * the context, and the JSON-body carrier preserves the type end-to-end. NEVER
 * carry these over headers (they stringify — `"False"` is truthy — the exact trap).
 */

export type SubscriptionPlan = "anon" | "free" | "pro" | "max";

/** Frozen shape — field names/types match SJ's GateContext exactly. */
export type GateContext = {
  is_authenticated: boolean;
  subscription_plan: SubscriptionPlan;
  /** The ADMIN-KEY actor flag (NOT `AuthState.is_admin`). Real boolean. */
  is_admin: boolean;
  /** The admin's clerk_user_id (= verified key `owner_id`). Present iff is_admin. */
  admin_subject?: string;
  /** `meta.phi_clearance AND GRAPHITI_PHI_ENABLED`. Real boolean. */
  phi_cleared: boolean;
  /** The turn's verified user identity (Clerk sub), when present. */
  user_subject?: string;
};

const SUBSCRIPTION_ORDER: readonly SubscriptionPlan[] = ["anon", "free", "pro", "max"];

/** Fail-closed: an unknown/absent plan is the LOWEST tier (anon). */
export function normalizeSubscriptionPlan(raw: unknown): SubscriptionPlan {
  return typeof raw === "string" && (SUBSCRIPTION_ORDER as readonly string[]).includes(raw)
    ? (raw as SubscriptionPlan)
    : "anon";
}

/** Ordinal rank for `subscription{min_tier}` comparison. anon=0 … max=3. */
export function subscriptionRank(plan: SubscriptionPlan): number {
  return SUBSCRIPTION_ORDER.indexOf(plan);
}

/**
 * Coerce a platform env flag (always a string, e.g. `GRAPHITI_PHI_ENABLED`) to a
 * REAL boolean. STRICT: only the exact token `"true"` (case-insensitive, trimmed)
 * or `"1"` is true; everything else — unset, `""`, `"false"`, `"0"`, garbage — is
 * false (fail-closed). This is the coercion devex's PIN 2 requires so the
 * conjunction below produces a real boolean, never a truthy string.
 */
export function envFlagEnabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * `phi_cleared = meta.phi_clearance AND GRAPHITI_PHI_ENABLED` (devex PIN 2).
 * `keyPhiClearance` comes from the validated key meta and MUST be a real boolean —
 * `=== true` rejects a truthy string/number by construction. `graphitiPhiEnabled`
 * is the already-coerced platform BAA flag. Both false → false (fail-closed).
 */
export function computePhiCleared(keyPhiClearance: unknown, graphitiPhiEnabled: boolean): boolean {
  // Same StrictBool rail as buildUserGateContext below — the compare is deliberate,
  // not redundant. (Pre-existing site; `extensions/` is ignored by the repo's default
  // lint config, so this only surfaces under the contract §8.1 real-lint invocation.)
  // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare
  return keyPhiClearance === true && graphitiPhiEnabled === true;
}

/**
 * The APP surface's own PHI stance, as a named decision rather than a bare
 * `true` buried in a security expression.
 *
 * The app is NOT a channel: A&D R4 deliberately excludes it from the D0
 * channel-capability model, so there is no `capabilitiesFor("app")` row to read
 * a `phi_approved` from. The app path must therefore DECLARE its answer, and
 * this constant is where that declaration lives — one grep-able place a reader
 * (or a reviewer) can find "what does the app claim about PHI, and why".
 *
 * DELIBERATELY UNUSED FOR NOW — not dead code. `buildUserGateContext` has zero
 * production callers today (increment 2c, which wires the `before_tool_call`
 * user arm, is unlanded). 2c is what consumes this; the channel arm passes
 * `capabilitiesFor(channelId)?.phi_approved ?? false` instead (unknown channel →
 * `false`, fail-closed).
 */
export const APP_SURFACE_PHI_APPROVED = true;

/** A verified admin identity, produced by the AdminKeyVerifyClient after the allowlist 2nd factor. */
export type AdminIdentity = {
  adminSubject: string; // = key owner_id, already asserted ∈ support_agent_subjects
  phiClearance: boolean; // key.meta.phi_clearance (real boolean)
};

/**
 * Build the USER-scoped context (the default; also the WhatsApp/partner path).
 * `is_admin` is `false` BY CONSTRUCTION — there is no admin identity here.
 *
 * `phi_cleared` for a user = the platform BAA flag (`GRAPHITI_PHI_ENABLED`) ALONE
 * (CTO ruling #5334, cleared by #5339): a signed-in user may read their OWN PHI
 * when the platform BAA is active. This is safe ONLY because every
 * `all_of[auth_required, phi]` tool is clerk_id-SELF-SCOPED by construction — the
 * gate does not confine cross-user reach, the TOOL does (SJ self-scoping rail,
 * PR #1624 / origin/test `c06bbbb6`, CI-enforced RED-first). The user path is NOT
 * admin-audited (you don't audit someone reading their own record). If
 * `graphitiPhiEnabled` is omitted, `phi_cleared` stays `false` (fail-closed).
 *
 * C4 adds the THIRD conjunct, `channelPhiApproved` — the surface the turn
 * arrived on must itself be PHI-approved. This is what makes the D0
 * `phi_approved` flag load-bearing instead of advisory (QG residual F22).
 * Callers source it from the D0 row: `capabilitiesFor(channelId)?.phi_approved
 * ?? false` (unknown channel → `false`, fail-closed), or from
 * {@link APP_SURFACE_PHI_APPROVED} on the app path, which has no D0 row.
 *
 * REQUIRED, not optional, and deliberately so: the app is not a channel, so
 * neither default is safe. Defaulting `false` would silently regress app PHI
 * access; defaulting `true` would FAIL OPEN on a PHI gate for any caller that
 * forgot the argument. Required forces every call site to state its answer, and
 * it is free right now because there are zero production callers.
 *
 * All three conjuncts use `=== true` (StrictBool): a truthy string/number must
 * never widen access — SJ's Pydantic `StrictBool` rejects those loudly, and the
 * client leg must agree with the server leg.
 */
export function buildUserGateContext(params: {
  externalId: string | undefined;
  graphitiPhiEnabled?: boolean;
  channelPhiApproved: boolean;
  subscriptionPlan?: unknown;
}): GateContext {
  const externalId = params.externalId?.trim() || undefined;
  return {
    is_authenticated: Boolean(externalId),
    subscription_plan: normalizeSubscriptionPlan(params.subscriptionPlan),
    is_admin: false,
    // A user reads their own PHI iff signed in AND the platform BAA is live AND
    // the surface the turn arrived on is itself PHI-approved.
    // NOTE: `channelPhiApproved` is an INPUT ONLY — the emitted GateContext gains
    // no field. Its shape mirrors SJ's exactly (ADR-0001 / SJ PR #1622) and the
    // JSON body SJ re-checks must stay byte-compatible.
    phi_cleared:
      Boolean(externalId) &&
      params.graphitiPhiEnabled === true &&
      // The compare is NOT unnecessary. The declared type is `boolean`, but the value
      // crosses an untyped runtime edge (a D0 JSON row / a hook ctx), where a caller
      // can hand us `"true"` or `1` through a cast. `=== true` is the StrictBool rail
      // that makes a truthy non-boolean fail CLOSED instead of widening PHI access —
      // the same rail SJ's Pydantic StrictBool enforces on the server leg.
      // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare
      params.channelPhiApproved === true,
    user_subject: externalId,
  };
}

/**
 * Build the ADMIN-scoped context — ONLY from a server-side-validated admin key
 * whose `owner_id` already passed the `support_agent_subjects` allowlist (the
 * never-self-approving 2nd factor lives in the verify client, not here). Identity
 * comes from the KEY, never the turn.
 *
 * NO CHANNEL TERM — a DECISION, not an omission. C4 adds `channelPhiApproved` to
 * the USER path only. Principal ruling (Phase 5 plan, "Admin path NOT gated"):
 * gating admin PHI on the channel would be pre-emptive — there is no
 * admin-over-channel operating mode today, so the term would be untestable
 * policy with no caller.
 *
 * REVISIT TRIGGER: if admin-over-channel ever becomes a real operating mode,
 * this reopens. An admin key IS reachable on a channel turn through the same
 * `before_tool_call` hook, so the asymmetry is only safe while nobody actually
 * drives an admin key from a channel. The moment one does, `phi_cleared` here
 * needs the same third conjunct the user path has.
 */
export function buildAdminGateContext(params: {
  admin: AdminIdentity;
  graphitiPhiEnabled: boolean;
  subscriptionPlan?: unknown;
  userSubject?: string;
}): GateContext {
  return {
    is_authenticated: true,
    subscription_plan: normalizeSubscriptionPlan(params.subscriptionPlan),
    is_admin: true,
    admin_subject: params.admin.adminSubject,
    phi_cleared: computePhiCleared(params.admin.phiClearance, params.graphitiPhiEnabled),
    user_subject: params.userSubject,
  };
}
