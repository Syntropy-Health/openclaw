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
  return keyPhiClearance === true && graphitiPhiEnabled === true;
}

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
 */
export function buildUserGateContext(params: {
  externalId: string | undefined;
  graphitiPhiEnabled?: boolean;
  subscriptionPlan?: unknown;
}): GateContext {
  const externalId = params.externalId?.trim() || undefined;
  return {
    is_authenticated: Boolean(externalId),
    subscription_plan: normalizeSubscriptionPlan(params.subscriptionPlan),
    is_admin: false,
    // A user reads their own PHI iff signed in AND the platform BAA is live.
    phi_cleared: Boolean(externalId) && params.graphitiPhiEnabled === true,
    user_subject: externalId,
  };
}

/**
 * Build the ADMIN-scoped context — ONLY from a server-side-validated admin key
 * whose `owner_id` already passed the `support_agent_subjects` allowlist (the
 * never-self-approving 2nd factor lives in the verify client, not here). Identity
 * comes from the KEY, never the turn.
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
