import { describe, expect, it } from "vitest";
import { capabilitiesFor, knownChannelIds } from "./channel-capability-config.js";
import {
  APP_SURFACE_PHI_APPROVED,
  buildAdminGateContext,
  buildUserGateContext,
  type GateContext,
} from "./gate-context.js";

// ---------------------------------------------------------------------------
// SEALED challenge suite — ocmca Phase 5, Task 5.1 (C4 GateContext PHI rail).
// Authored from PLAN.md §"Phase 5 — C4 GateContext PHI rail" + the FROZEN
// GateContext contract + the landed D0 table ONLY. NO implementation was read.
//
// THE CONTRACT UNDER CHALLENGE
//   `buildUserGateContext` takes a REQUIRED `channelPhiApproved: boolean`, and
//       phi_cleared = Boolean(externalId)
//                     && graphitiPhiEnabled === true
//                     && channelPhiApproved === true
//   i.e. PHI clears IFF *all three* of (signed in, platform BAA live, channel
//   PHI-approved) hold. Any one false → denied, fail-closed.
//
//   `channelPhiApproved` is an INPUT PARAM ONLY. The emitted GateContext gains
//   NO new field — its field names/types mirror SJ's exactly (ADR-0001 / SJ PR
//   #1622) and the JSON body SJ re-checks must stay BYTE-COMPATIBLE. A test
//   below fails loudly if `channelPhiApproved` ever shows up in the OUTPUT.
//
//   `APP_SURFACE_PHI_APPROVED = true` is the app path's declared stance: the app
//   is NOT a channel and has no D0 row (A&D R4 excludes it), so it states its
//   answer through a named constant rather than a bare literal in a security
//   expression.
//
//   `buildAdminGateContext` gets NO channel term — see the ASYMMETRY note on
//   that describe block. That is a principal RULING, not an oversight.
//
// RED STATE (expected, and correct): `channelPhiApproved` is REQUIRED, so this
// file does NOT COMPILE until the implementation lands — `tsgo` failing IS the
// red. It is the strongest possible red: the contract is unsatisfiable until
// implemented. These tests are deliberately NOT weakened to compile early.
//
// AMBIGUITIES FLAGGED FOR THE PRINCIPAL (not guessed at — see the assertions):
//   Q1. Shape lock, signed-OUT arm: the frozen type declares `user_subject?:
//       string`, and the contract file assigns it unconditionally, so a
//       signed-out context carries the KEY with value `undefined`. Whether that
//       key must be PRESENT-but-undefined or ABSENT for a signed-out user is not
//       stated by the spec, and `JSON.stringify` erases the difference anyway.
//       This suite therefore asserts the signed-out key set is a SUBSET of the
//       frozen field list (which is what actually guards SJ's re-check: no NEW
//       key) and asserts EXACT key-set equality only on the signed-in arm, where
//       the spec is determinate. Rule either way and this can tighten.
//   Q2. Module home of `APP_SURFACE_PHI_APPROVED`: the spec says
//       `buildUserGateContext`'s module "ALSO exports" it, so it is imported
//       here from `./gate-context.js`. If it is meant to live elsewhere, this
//       import is the thing to move.
//   Q3. `graphitiPhiEnabled` remains OPTIONAL (only `channelPhiApproved` was
//       ruled required); this suite pins its omission to the documented
//       fail-closed `false`.
// ---------------------------------------------------------------------------

/** A stable, non-blank Clerk sub — "signed in" for the truth table. */
const SIGNED_IN = "user_2abcDEFghiJKL";

/** The frozen GateContext field list (ADR-0001 / SJ PR #1622). Nothing else. */
const FROZEN_USER_KEYS = [
  "is_admin",
  "is_authenticated",
  "phi_cleared",
  "subscription_plan",
  "user_subject",
].toSorted();

const FROZEN_ADMIN_KEYS = ["admin_subject", ...FROZEN_USER_KEYS].toSorted();

// ===========================================================================
// 1. EXHAUSTIVE TRUTH TABLE — all 8 rows of
//    (signedIn × graphitiPhiEnabled × channelPhiApproved).
//    One `it` per row, no loop: a failure names the exact row that broke.
// ===========================================================================
describe("buildUserGateContext — phi_cleared truth table (all 8 rows)", () => {
  it("row 1/8: signedIn=T, baa=T, channel=T → phi_cleared TRUE (the only true row)", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(true);
    expect(typeof ctx.phi_cleared).toBe("boolean");
    expect(ctx.is_authenticated).toBe(true);
  });

  it("row 2/8: signedIn=T, baa=T, channel=F → phi_cleared FALSE (channel denies)", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: false,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
    // The channel term denies PHI WITHOUT denying authentication — the user is
    // still signed in on that channel; only the PHI rail closes.
    expect(ctx.is_authenticated).toBe(true);
  });

  it("row 3/8: signedIn=T, baa=F, channel=T → phi_cleared FALSE (no platform BAA)", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: false,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("row 4/8: signedIn=T, baa=F, channel=F → phi_cleared FALSE", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: false,
      channelPhiApproved: false,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("row 5/8: signedIn=F, baa=T, channel=T → phi_cleared FALSE (anon never reads PHI)", () => {
    const ctx = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
    expect(ctx.is_authenticated).toBe(false);
  });

  it("row 6/8: signedIn=F, baa=T, channel=F → phi_cleared FALSE", () => {
    const ctx = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: true,
      channelPhiApproved: false,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("row 7/8: signedIn=F, baa=F, channel=T → phi_cleared FALSE", () => {
    const ctx = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: false,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("row 8/8: signedIn=F, baa=F, channel=F → phi_cleared FALSE", () => {
    const ctx = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: false,
      channelPhiApproved: false,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("a BLANK/whitespace externalId is NOT signed in — it cannot clear PHI", () => {
    // The contract trims and treats blank as absent, so whitespace must land on
    // the signed-OUT rows even with BAA + channel both approving.
    const blank = buildUserGateContext({
      externalId: "   ",
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    expect(blank.is_authenticated).toBe(false);
    expect(blank.phi_cleared).toBe(false);

    const empty = buildUserGateContext({
      externalId: "",
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    expect(empty.is_authenticated).toBe(false);
    expect(empty.phi_cleared).toBe(false);
  });

  it("an OMITTED graphitiPhiEnabled stays fail-closed even with the channel approving", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("the channel term is LOAD-BEARING: flipping ONLY channelPhiApproved flips the outcome", () => {
    // Guards against an implementation that accepts the param and ignores it
    // (or hard-codes it), which would make the whole rail advisory again (F22).
    const base = { externalId: SIGNED_IN, graphitiPhiEnabled: true } as const;
    expect(buildUserGateContext({ ...base, channelPhiApproved: true }).phi_cleared).toBe(true);
    expect(buildUserGateContext({ ...base, channelPhiApproved: false }).phi_cleared).toBe(false);
  });

  it("channelPhiApproved is REQUIRED — omitting it must not compile, and fails CLOSED if reached", () => {
    // WHY the directive is the guard, not the assertion: `@ts-expect-error` is an
    // ERROR when the line it covers has NO error (TS2578). So the moment the
    // signature is relaxed to `channelPhiApproved?: boolean`, this call starts
    // compiling, the directive becomes UNUSED, and tsgo fails. That is the ONLY
    // durable proof of the "Required, not optional" ruling: the original red was a
    // compile error that vanished the instant all 51 call sites passed the
    // argument, so nothing else in this suite can tell a required param from an
    // optional one.
    //
    // BOTH halves are load-bearing. Made optional with a `true` default (the
    // fail-OPEN mutant, PLAN §5.2's named failure mode), the runtime assertion
    // below ALSO fails; made optional with a `false` default, only the directive
    // catches it. Do not "simplify" either half away.
    // @ts-expect-error channelPhiApproved is REQUIRED. If it is ever made optional,
    // this call compiles, the directive becomes unused, and tsgo fails with TS2578.
    const ctx: GateContext = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
    });
    expect(ctx.phi_cleared).toBe(false);
  });
});

// ===========================================================================
// 2. STRICTBOOL DISCIPLINE
//    SJ's Pydantic StrictBool rejects a stringified/numeric bool LOUDLY. A
//    truthy non-boolean must never widen access, and the emitted phi_cleared
//    must always be a REAL boolean (never a truthy string leaking through).
// ===========================================================================
describe("buildUserGateContext — StrictBool discipline (truthy non-booleans must NOT widen access)", () => {
  it('channelPhiApproved = "true" (string) does NOT clear PHI', () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: "true" as unknown as boolean,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("channelPhiApproved = 1 (number) does NOT clear PHI", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: 1 as unknown as boolean,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("channelPhiApproved = {} (truthy object) does NOT clear PHI", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: {} as unknown as boolean,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it('graphitiPhiEnabled = "true" (string) does NOT clear PHI', () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: "true" as unknown as boolean,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("graphitiPhiEnabled = 1 (number) does NOT clear PHI", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: 1 as unknown as boolean,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("graphitiPhiEnabled = {} (truthy object) does NOT clear PHI", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: {} as unknown as boolean,
      channelPhiApproved: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("BOTH flags truthy-but-not-boolean still denies, and still emits a REAL boolean", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: "1" as unknown as boolean,
      channelPhiApproved: "yes" as unknown as boolean,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
    // is_admin is the other StrictBool field on the user path — false BY
    // CONSTRUCTION, and a real boolean, regardless of what was fed in.
    expect(ctx.is_admin).toBe(false);
    expect(typeof ctx.is_admin).toBe("boolean");
  });

  it("phi_cleared is a REAL boolean on the truthy-input rows AND the all-true row", () => {
    const cleared = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    expect(typeof cleared.phi_cleared).toBe("boolean");
    // JSON is the carrier SJ re-checks — a truthy string would serialize as
    // `"phi_cleared":"true"` and SJ's StrictBool would reject the body.
    const clearedWire = JSON.parse(JSON.stringify(cleared)) as Record<string, unknown>;
    expect(clearedWire.phi_cleared).toBe(true);

    const denied = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: "true" as unknown as boolean,
    });
    expect(typeof denied.phi_cleared).toBe("boolean");
    const deniedWire = JSON.parse(JSON.stringify(denied)) as Record<string, unknown>;
    expect(deniedWire.phi_cleared).toBe(false);
  });
});

// ===========================================================================
// 3. SHAPE LOCK — the emitted GateContext gains NO new key.
//    This is the regression guard for SJ's JSON re-check (byte-compatibility
//    with SJ PR #1622). `channelPhiApproved` is an INPUT ONLY.
// ===========================================================================
describe("GateContext shape lock — channelPhiApproved must NEVER reach the OUTPUT", () => {
  it("a signed-in user context has EXACTLY the frozen field set", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    expect(Object.keys(ctx).toSorted()).toStrictEqual(FROZEN_USER_KEYS);
    // No admin fields ever appear on the user path.
    expect(Object.keys(ctx)).not.toContain("admin_subject");
  });

  it("a signed-out user context introduces NO key outside the frozen set (see Q1)", () => {
    const ctx = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: false,
      channelPhiApproved: false,
    });
    for (const key of Object.keys(ctx)) {
      expect(FROZEN_USER_KEYS).toContain(key);
    }
    // The four unconditional fields are always present, whatever Q1 rules.
    expect(Object.keys(ctx)).toEqual(
      expect.arrayContaining(["is_authenticated", "subscription_plan", "is_admin", "phi_cleared"]),
    );
  });

  it("NO combination of channelPhiApproved leaks a channel key into the emitted object", () => {
    const cleared = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    const denied = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: false,
    });
    const anonCleared = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
    });
    const anonDenied = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: false,
      channelPhiApproved: false,
    });
    for (const ctx of [cleared, denied, anonCleared, anonDenied]) {
      expect(Object.keys(ctx)).not.toContain("channelPhiApproved");
      expect(Object.keys(ctx)).not.toContain("channel_phi_approved");
      expect(Object.keys(ctx)).not.toContain("phi_approved");
      expect(Object.keys(ctx)).not.toContain("channel");
    }
  });

  it("the JSON body SJ re-checks carries the frozen keys and nothing more", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: false,
    });
    const wire = JSON.parse(JSON.stringify(ctx)) as Record<string, unknown>;
    expect(Object.keys(wire).toSorted()).toStrictEqual(FROZEN_USER_KEYS);
    expect(wire).toStrictEqual({
      is_authenticated: true,
      subscription_plan: "anon",
      is_admin: false,
      phi_cleared: false,
      user_subject: SIGNED_IN,
    });
  });

  it("the returned value is assignable to the FROZEN GateContext type (no widened shape)", () => {
    const ctx: GateContext = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: true,
      subscriptionPlan: "pro",
    });
    expect(ctx.subscription_plan).toBe("pro");
    expect(ctx.user_subject).toBe(SIGNED_IN);
  });

  it("an admin context still has EXACTLY the frozen admin field set (no channel key)", () => {
    const ctx = buildAdminGateContext({
      admin: { adminSubject: "user_2adminXYZ", phiClearance: true },
      graphitiPhiEnabled: true,
    });
    expect(Object.keys(ctx).toSorted()).toStrictEqual(FROZEN_ADMIN_KEYS);
    expect(Object.keys(ctx)).not.toContain("channelPhiApproved");
  });
});

// ===========================================================================
// 4. ADMIN PATH UNCHANGED
//
//    DELIBERATE ASYMMETRY — NOT AN OVERSIGHT. `buildAdminGateContext` takes NO
//    channel term: phi_cleared stays (key clearance AND platform BAA flag). This
//    is a PRINCIPAL RULING (PLAN.md Phase 5 "Rulings baked in" → "Admin path NOT
//    gated"): admin/RBAC channel gating is PRE-EMPTIVE for now, since no admin
//    key is exercised over a channel turn today.
//
//    REVISIT TRIGGER (explicit, so this asymmetry is not inherited silently):
//    if admin-over-channel ever becomes a REAL operating mode — an admin key
//    reaching `before_tool_call` on a channel turn, which the same hook makes
//    physically possible — this ruling REOPENS and the admin path must take the
//    channel term too. Until then, these tests pin the admin path as UNCHANGED
//    so a well-meaning "consistency" edit fails loudly and gets re-ruled.
// ===========================================================================
describe("buildAdminGateContext — UNCHANGED by Phase 5 (deliberate asymmetry, see block comment)", () => {
  it("admin: clearance=T, baa=T → phi_cleared TRUE", () => {
    const ctx = buildAdminGateContext({
      admin: { adminSubject: "user_2adminXYZ", phiClearance: true },
      graphitiPhiEnabled: true,
    });
    expect(ctx.phi_cleared).toBe(true);
    expect(typeof ctx.phi_cleared).toBe("boolean");
    expect(ctx.is_admin).toBe(true);
    expect(ctx.admin_subject).toBe("user_2adminXYZ");
  });

  it("admin: clearance=T, baa=F → phi_cleared FALSE", () => {
    const ctx = buildAdminGateContext({
      admin: { adminSubject: "user_2adminXYZ", phiClearance: true },
      graphitiPhiEnabled: false,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("admin: clearance=F, baa=T → phi_cleared FALSE", () => {
    const ctx = buildAdminGateContext({
      admin: { adminSubject: "user_2adminXYZ", phiClearance: false },
      graphitiPhiEnabled: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("admin: clearance=F, baa=F → phi_cleared FALSE", () => {
    const ctx = buildAdminGateContext({
      admin: { adminSubject: "user_2adminXYZ", phiClearance: false },
      graphitiPhiEnabled: false,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("admin StrictBool is preserved: a truthy non-boolean clearance does NOT clear PHI", () => {
    const ctx = buildAdminGateContext({
      admin: {
        adminSubject: "user_2adminXYZ",
        phiClearance: "true" as unknown as boolean,
      },
      graphitiPhiEnabled: true,
    });
    expect(ctx.phi_cleared).toBe(false);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("the ASYMMETRY itself: a channel denial that closes the USER path leaves the ADMIN path open", () => {
    // Deliberately states the asymmetry with a LITERAL channel denial rather than
    // by iterating D0. What D0's rows say today is channel-capability-config's
    // invariant to own; re-asserting it here would make the post-BAA
    // `phi_approved` flip redden tests that are not about D0's contents.
    const userCtx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: false,
    });
    expect(userCtx.phi_cleared).toBe(false);

    // Same platform BAA, same turn — the admin builder takes NO channel term at
    // all, so nothing about the surface can close it. Revisit trigger, not a bug.
    const adminCtx = buildAdminGateContext({
      admin: { adminSubject: "user_2adminXYZ", phiClearance: true },
      graphitiPhiEnabled: true,
      userSubject: SIGNED_IN,
    });
    expect(adminCtx.phi_cleared).toBe(true);
  });
});

// ===========================================================================
// 5. APP SURFACE CONSTANT
//    The app is NOT a channel and has no D0 row, so its stance is a NAMED
//    constant — the literal in a security expression must read as a decision.
// ===========================================================================
describe("APP_SURFACE_PHI_APPROVED — the app path's declared stance", () => {
  it("is the real boolean `true` (not a truthy string/number)", () => {
    expect(APP_SURFACE_PHI_APPROVED).toBe(true);
    expect(typeof APP_SURFACE_PHI_APPROVED).toBe("boolean");
  });

  it("a signed-in, BAA-on user on the APP surface keeps PHI (phi_cleared TRUE)", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: APP_SURFACE_PHI_APPROVED,
    });
    expect(ctx.phi_cleared).toBe(true);
    expect(typeof ctx.phi_cleared).toBe("boolean");
  });

  it("the app stance does NOT rescue a signed-out user", () => {
    const ctx = buildUserGateContext({
      externalId: undefined,
      graphitiPhiEnabled: true,
      channelPhiApproved: APP_SURFACE_PHI_APPROVED,
    });
    expect(ctx.phi_cleared).toBe(false);
  });

  it("the app stance does NOT rescue a BAA-off platform", () => {
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: false,
      channelPhiApproved: APP_SURFACE_PHI_APPROVED,
    });
    expect(ctx.phi_cleared).toBe(false);
  });

  it("the app constant is NOT a D0 channel id — the app has no capability row", () => {
    // Guards the rejected alternative (adding an `app` row to D0), which would
    // smuggle the app into a model the A&D deliberately excludes it from.
    expect(knownChannelIds()).not.toContain("app");
    expect(capabilitiesFor("app")).toBeNull();
  });
});

// ===========================================================================
// 6. D0 SOURCING — the realistic caller wiring
//    Callers source the param as `capabilitiesFor(channelId)?.phi_approved ??
//    false` (null → false, fail-closed for an unknown channel).
// ===========================================================================
describe("D0-sourced channelPhiApproved — the wiring 2c will use", () => {
  it("whatsapp (D0 phi_approved:false) DENIES PHI for a signed-in, BAA-on user", () => {
    // `?? false` ABSORBS a missing row: without these two lines, DELETING the
    // whatsapp row from D0 entirely leaves this test green — it would then be
    // proving the fail-closed default, not that whatsapp's row says false.
    expect(capabilitiesFor("whatsapp")).not.toBeNull();
    // Strictly `false`, not `undefined` — `?? false` cannot see the difference.
    expect(capabilitiesFor("whatsapp")?.phi_approved).toBe(false);

    const channelPhiApproved = capabilitiesFor("whatsapp")?.phi_approved ?? false;
    expect(channelPhiApproved).toBe(false);
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved,
    });
    expect(ctx.phi_cleared).toBe(false);
    // Still authenticated on WhatsApp — only the PHI rail closes.
    expect(ctx.is_authenticated).toBe(true);
  });

  it("EVERY known D0 channel's row REACHES phi_cleared faithfully (total over the table)", () => {
    // TOTALITY OVER THE FLOW, NOT OVER D0'S CONTENTS. "every row says false
    // today" is channel-capability-config.test.ts's invariant and is asserted
    // there; duplicating it here would make the deliberate post-BAA
    // `phi_approved` flip redden this file too. What THIS file owns is that the
    // sourcing expression carries each row's answer through to `phi_cleared`
    // unaltered — which stays true, and stays checked, after that flip.
    const ids = knownChannelIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const channelId of ids) {
      const row = capabilitiesFor(channelId);
      // A declared channel MUST resolve to a row; `?? false` below would
      // otherwise silently substitute the unknown-channel default for it.
      expect({ channelId, row: row === null }).toStrictEqual({ channelId, row: false });
      // A REAL boolean, never `undefined` — `?? false` cannot tell those apart.
      expect({ channelId, type: typeof row?.phi_approved }).toStrictEqual({
        channelId,
        type: "boolean",
      });

      const channelPhiApproved = capabilitiesFor(channelId)?.phi_approved ?? false;
      const ctx = buildUserGateContext({
        externalId: SIGNED_IN,
        graphitiPhiEnabled: true,
        channelPhiApproved,
      });
      // Signed in + BAA on, so phi_cleared is exactly the row's own answer. A
      // row whose flag is ignored, hard-coded, or inverted fails here by name.
      expect({ channelId, phi_cleared: ctx.phi_cleared }).toStrictEqual({
        channelId,
        phi_cleared: row?.phi_approved,
      });
    }
  });

  it("an UNKNOWN channel id (telegram → null → ?? false) DENIES, fail-closed", () => {
    expect(capabilitiesFor("telegram")).toBeNull();
    const channelPhiApproved = capabilitiesFor("telegram")?.phi_approved ?? false;
    expect(channelPhiApproved).toBe(false);
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved,
    });
    expect(ctx.phi_cleared).toBe(false);
  });

  it("a prototype-chain key ('__proto__') sourced from D0 also DENIES, fail-closed", () => {
    expect(capabilitiesFor("__proto__")).toBeNull();
    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: capabilitiesFor("__proto__")?.phi_approved ?? false,
    });
    expect(ctx.phi_cleared).toBe(false);
  });

  it("a POST-BAA row (phi_approved flipped true) CLEARS PHI — the rail is not hard-coded false", () => {
    // Simulates the deliberate post-BAA config flip WITHOUT touching D0: the
    // param must actually carry the channel's answer through, otherwise the
    // rail would be permanently-deny theatre rather than enforcement (F22).
    const liveRow = capabilitiesFor("whatsapp");
    // Spreading a NULL yields `{}`, and `phi_approved: true` is written over the
    // top unconditionally — so without these three lines the "post-BAA D0 row"
    // is indistinguishable from truth-table row 1/8 wearing a costume, and would
    // read identically if capabilitiesFor returned null for everything.
    expect(liveRow).not.toBeNull();
    const postBaaRow = { ...liveRow, phi_approved: true };
    // The spread must actually CARRY the row: whatsapp's other capability fields
    // have to survive into the object being fed to the builder.
    expect(postBaaRow.inline_link).toBe(true);
    expect(postBaaRow.inline_text).toBe(true);

    const ctx = buildUserGateContext({
      externalId: SIGNED_IN,
      graphitiPhiEnabled: true,
      channelPhiApproved: postBaaRow.phi_approved,
    });
    expect(ctx.phi_cleared).toBe(true);
  });
});
