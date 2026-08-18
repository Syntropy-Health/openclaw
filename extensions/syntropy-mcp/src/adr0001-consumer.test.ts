import { describe, expect, it, vi } from "vitest";
import { AdminKeyVerifyClient, type UnkeyVerifyResult } from "./admin-key.js";
import {
  APP_SURFACE_PHI_APPROVED,
  buildAdminGateContext,
  buildUserGateContext,
} from "./gate-context.js";
import { PhiAuditClient } from "./phi-audit.js";
import { toolGateGuard, type PhiAuditDep } from "./tool-gate-guard.js";
import type { Gate } from "./tool-gate.js";

const ADMIN_SUBJECT = "user_admin1";
const ALLOWLIST = [ADMIN_SUBJECT, "user_admin2"];

function client(verify: (k: string) => Promise<UnkeyVerifyResult>, now = () => 1_000) {
  return new AdminKeyVerifyClient({
    allowlist: ALLOWLIST,
    verify: vi.fn(verify),
    cacheTtlMs: 30_000,
    now,
  });
}

// ── AdminKeyVerifyClient (two-factor, fail-closed, cache) ─────────────────────
describe("AdminKeyVerifyClient", () => {
  it("valid key + allowlisted owner → AdminIdentity (phiClearance from real-bool meta)", async () => {
    const c = client(async () => ({
      valid: true,
      ownerId: ADMIN_SUBJECT,
      meta: { phi_clearance: true },
      code: "VALID",
    }));
    const id = await c.resolveAdmin("sa_good");
    expect(id).toEqual({ adminSubject: ADMIN_SUBJECT, phiClearance: true });
  });

  it("non-sa_ key → null (not an admin candidate), verify never called", async () => {
    const verify = vi.fn(async () => ({ valid: true, ownerId: ADMIN_SUBJECT }));
    const c = new AdminKeyVerifyClient({ allowlist: ALLOWLIST, verify });
    expect(await c.resolveAdmin("clerk_jwt_xyz")).toBeNull();
    expect(await c.resolveAdmin(undefined)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it("invalid key → null, NOT cached", async () => {
    const verify = vi.fn(async () => ({ valid: false, code: "KEY_DISABLED" }) as UnkeyVerifyResult);
    const c = new AdminKeyVerifyClient({ allowlist: ALLOWLIST, verify });
    expect(await c.resolveAdmin("sa_revoked")).toBeNull();
    await c.resolveAdmin("sa_revoked");
    expect(verify).toHaveBeenCalledTimes(2); // negatives never cached
  });

  it("2nd factor: valid key whose owner is NOT allowlisted → null (valid key alone ≠ admin)", async () => {
    const c = client(async () => ({
      valid: true,
      ownerId: "user_stranger",
      meta: { phi_clearance: true },
    }));
    expect(await c.resolveAdmin("sa_valid_but_unlisted")).toBeNull();
  });

  it("verify throws (Unkey unreachable) → null (fail-closed)", async () => {
    const c = client(async () => {
      throw new Error("network");
    });
    expect(await c.resolveAdmin("sa_x")).toBeNull();
  });

  it("StrictBool source: meta.phi_clearance='true' (string) → phiClearance false", async () => {
    const c = client(async () => ({
      valid: true,
      ownerId: ADMIN_SUBJECT,
      meta: { phi_clearance: "true" },
    }));
    const id = await c.resolveAdmin("sa_stringbool");
    expect(id?.phiClearance).toBe(false);
  });

  it("positive cache: 2nd resolve within TTL hits cache (verify once)", async () => {
    const verify = vi.fn(
      async () => ({ valid: true, ownerId: ADMIN_SUBJECT, meta: {} }) as UnkeyVerifyResult,
    );
    const c = new AdminKeyVerifyClient({
      allowlist: ALLOWLIST,
      verify,
      cacheTtlMs: 30_000,
      now: () => 1_000,
    });
    await c.resolveAdmin("sa_cached");
    await c.resolveAdmin("sa_cached");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("single-flight: concurrent resolves share one verify", async () => {
    const verify = vi.fn(
      async () => ({ valid: true, ownerId: ADMIN_SUBJECT, meta: {} }) as UnkeyVerifyResult,
    );
    const c = new AdminKeyVerifyClient({ allowlist: ALLOWLIST, verify });
    await Promise.all([
      c.resolveAdmin("sa_conc"),
      c.resolveAdmin("sa_conc"),
      c.resolveAdmin("sa_conc"),
    ]);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("invalidate drops the positive → re-verifies", async () => {
    const verify = vi.fn(
      async () => ({ valid: true, ownerId: ADMIN_SUBJECT, meta: {} }) as UnkeyVerifyResult,
    );
    const c = new AdminKeyVerifyClient({ allowlist: ALLOWLIST, verify, now: () => 1_000 });
    await c.resolveAdmin("sa_inv");
    c.invalidate("sa_inv");
    await c.resolveAdmin("sa_inv");
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

// ── PhiAuditClient (201-or-fail, service token, PHI-free) ─────────────────────
function auditClient(fetchImpl: typeof fetch) {
  return new PhiAuditClient({
    endpoint: "https://sj/api/admin/phi-audit",
    serviceToken: "svc_tok",
    fetchImpl,
  });
}
const REC = {
  admin_subject: "a",
  target_clerk_id: "t",
  tool: "orders_read",
  ts: "2026-07-30T00:00:00Z",
};

describe("PhiAuditClient", () => {
  it("201 → ok, sends the SERVICE token (not an admin key) + the record", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 201 }),
    ) as unknown as typeof fetch;
    const res = await auditClient(fetchImpl).write(REC);
    expect(res.ok).toBe(true);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer svc_tok");
    expect(JSON.parse(init.body as string)).toEqual(REC);
  });
  it("non-201 → NOT ok (guard will deny)", async () => {
    for (const status of [200, 403, 500]) {
      const f = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
      expect((await auditClient(f).write(REC)).ok).toBe(false);
    }
  });
  it("fetch throws (timeout/network) → NOT ok", async () => {
    const f = vi.fn(async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect((await auditClient(f).write(REC)).ok).toBe(false);
  });
});

// ── ToolGate guard (enforcement at dispatch) ──────────────────────────────────
const adminCtx = buildAdminGateContext({
  admin: { adminSubject: ADMIN_SUBJECT, phiClearance: true },
  graphitiPhiEnabled: true,
});
// is_admin=false by construction. `channelPhiApproved: false` is the D0 truth for
// this surface (`whatsapp.phi_approved === false` — no BAA with Meta), NOT a
// convenience default: this context is explicitly a WhatsApp one, so passing
// `true` here would assert in the ADR-0001 consumer suite the exact falsehood
// C4 exists to prevent.
const whatsappUserCtx = buildUserGateContext({
  externalId: "user_wa",
  subscriptionPlan: "pro",
  channelPhiApproved: false,
});

function phiAuditDep(ok: boolean, spy?: () => void): PhiAuditDep {
  return {
    client: {
      write: async () => {
        spy?.();
        return { ok };
      },
    } as unknown as PhiAuditClient,
    resolveTargetClerkId: () => "user_target",
    nowIso: () => "2026-07-30T00:00:00Z",
  };
}

/** A bare `phi` gate — the shared resolveGate for the phi-leg cases below. */
const phiGate = () => ({ kind: "phi" }) as Gate;

describe("toolGateGuard — enforcement at dispatch", () => {
  it("WHATSAPP NEGATIVE: a whatsapp/user turn to an admin_required tool is BLOCKED", async () => {
    const r = await toolGateGuard(
      "orders_read",
      {},
      {
        resolveGate: () => ({ kind: "admin_required" }) as Gate,
        gateContext: whatsappUserCtx,
      },
    );
    expect(r?.block).toBe(true);
    expect(r?.blockReason).toContain("admin_required");
  });

  it("absent annotation → auth_required floor → allow for an authed user", async () => {
    const r = await toolGateGuard(
      "some_read",
      {},
      { resolveGate: () => undefined, gateContext: whatsappUserCtx },
    );
    expect(r).toBeUndefined();
  });

  it("malformed gate (null) → block", async () => {
    const r = await toolGateGuard("x", {}, { resolveGate: () => null, gateContext: adminCtx });
    expect(r?.block).toBe(true);
  });

  it("admin ctx + admin_required → allow", async () => {
    const r = await toolGateGuard(
      "orders_read",
      {},
      {
        resolveGate: () => ({ kind: "admin_required" }) as Gate,
        gateContext: adminCtx,
      },
    );
    expect(r).toBeUndefined();
  });

  it("phi tool + cleared + audit 201 → allow (audit WRITTEN before allow)", async () => {
    const spy = vi.fn();
    const r = await toolGateGuard(
      "health_search",
      {},
      {
        resolveGate: () =>
          ({
            kind: "composite",
            op: "all_of",
            members: [{ kind: "admin_required" }, { kind: "phi" }],
          }) as Gate,
        gateContext: adminCtx,
        phiAudit: phiAuditDep(true, spy),
      },
    );
    expect(spy).toHaveBeenCalledTimes(1); // audit happened
    expect(r).toBeUndefined(); // then allowed
  });

  it("AUDIT-BEFORE-RESULT: phi tool + audit non-201 → BLOCK (result never returns)", async () => {
    const spy = vi.fn();
    const r = await toolGateGuard(
      "health_search",
      {},
      {
        resolveGate: () => ({ kind: "phi" }) as Gate,
        gateContext: adminCtx,
        phiAudit: phiAuditDep(false, spy),
      },
    );
    expect(spy).toHaveBeenCalledTimes(1); // audit was attempted
    expect(r?.block).toBe(true); // and the tool denied
  });

  it("phi tool but NO audit sink configured → block (fail-closed)", async () => {
    const r = await toolGateGuard(
      "health_search",
      {},
      {
        resolveGate: () => ({ kind: "phi" }) as Gate,
        gateContext: adminCtx,
      },
    );
    expect(r?.block).toBe(true);
  });

  it("phi tool with no resolvable target clerk_id → block", async () => {
    const dep: PhiAuditDep = { ...phiAuditDep(true), resolveTargetClerkId: () => undefined };
    const r = await toolGateGuard(
      "health_search",
      {},
      {
        resolveGate: () => ({ kind: "phi" }) as Gate,
        gateContext: adminCtx,
        phiAudit: dep,
      },
    );
    expect(r?.block).toBe(true);
  });

  // ── C4 (Phase 5): the D0 `phi_approved` flag is LOAD-BEARING, not advisory ──
  // Its OWN block, after the phi-audit sequence above, so it stops splitting
  // that sequence. Every name says "guard-level": 5.2 lands the DISPATCH-level
  // pair (which additionally proves the channel survives the session cache) and
  // the two must stay tellable apart across the three-file split. This is not a
  // substitute for 5.2's pair.
  describe("C4 channel PHI rail (guard-level)", () => {
    // Same signed-in user, same platform BAA ON, same phi-gated tool, same audit
    // sink — the ONLY difference between the arms is the surface's PHI stance,
    // so the user id must be surface-NEUTRAL (it is reused on the APP arm).
    const SIGNED_IN_USER = "user_signed_in";

    it("C4 (guard-level): WhatsApp turn + BAA on → phi tool DENIED at the GATE", async () => {
      const waWithBaa = buildUserGateContext({
        externalId: SIGNED_IN_USER,
        graphitiPhiEnabled: true,
        channelPhiApproved: false, // D0 row for whatsapp
      });
      // Pre-C4 this context WAS phi_cleared (signed in + BAA); the channel term is
      // what now denies it. Asserting the post-Phase-5 truth, not forcing green.
      expect(waWithBaa.phi_cleared).toBe(false);
      const r = await toolGateGuard(
        "health_search",
        {},
        { resolveGate: phiGate, gateContext: waWithBaa, phiAudit: phiAuditDep(true) },
      );
      expect(r?.block).toBe(true);
      // EXACT, not `toContain("phi")`: three AUDIT-leg reasons in tool-gate-guard
      // also contain "phi" ("phi tool — audit sink not configured — denied", "phi
      // tool — no target clerk_id — denied", "phi audit write failed — denied"),
      // so a substring match would pass under a guard that blanket-denies every
      // phi tool and never consults phi_cleared at all. `"phi denied"` is the
      // GATE leg (`${failing_kind} denied`) and pins the leg this test is about.
      expect(r?.blockReason).toBe("phi denied");
    });

    it("C4 (guard-level): app turn + BAA on → phi tool ALLOWED (app declares its stance, has no D0 row)", async () => {
      const appWithBaa = buildUserGateContext({
        externalId: SIGNED_IN_USER,
        graphitiPhiEnabled: true,
        channelPhiApproved: APP_SURFACE_PHI_APPROVED,
      });
      expect(appWithBaa.phi_cleared).toBe(true);
      const r = await toolGateGuard(
        "health_search",
        {},
        { resolveGate: phiGate, gateContext: appWithBaa, phiAudit: phiAuditDep(true) },
      );
      expect(r).toBeUndefined();
    });
  });
});
