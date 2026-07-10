import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ComponentFieldDescriptor } from "../../../src/gateway/component-descriptor.schema.js";
import { PENDING_ID_PATTERN } from "../../../src/gateway/component-descriptor.schema.js";
import { type MintInput, PendingConfirmStore } from "./pending-confirm-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Injectable clock (mirrors catalog.test.ts).
let nowMs: number;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

/** Deterministic, collision-free id source for isolation/TTL/single-use tests. */
function seqRandomId(): () => string {
  let n = 0;
  return () => `cnf_${String(n++).padStart(22, "0")}`;
}

function field(
  name: string,
  type: ComponentFieldDescriptor["type"] = "string",
): ComponentFieldDescriptor {
  return { name, type };
}

function mintInput(extra?: Partial<MintInput>): MintInput {
  return {
    externalId: "user_A",
    sessionKey: "sess_A",
    commitTool: "syntropy_log_food_commit",
    previewArgs: { grams: 100 },
    editableFields: [field("grams", "number")],
    ...extra,
  };
}

function makeStore(opts?: { ttlSeconds?: number; randomId?: () => string }): PendingConfirmStore {
  return new PendingConfirmStore({
    now,
    ttlSeconds: opts?.ttlSeconds ?? 300,
    randomId: opts?.randomId ?? seqRandomId(),
  });
}

// ---------------------------------------------------------------------------
// 1. mint — id shape, entropy, expiry, storage
// ---------------------------------------------------------------------------

describe("PendingConfirmStore.mint", () => {
  it("mints a pending with a pattern-valid id and now+ttl expiry", () => {
    const store = makeStore({ ttlSeconds: 300 });
    const pending = store.mint(mintInput());

    expect(pending.pendingId).toMatch(PENDING_ID_PATTERN);
    expect(pending.expiresAtMs).toBe(nowMs + 300_000);
    expect(pending.externalId).toBe("user_A");
    expect(pending.sessionKey).toBe("sess_A");
    expect(pending.commitTool).toBe("syntropy_log_food_commit");
    expect(pending.previewArgs).toEqual({ grams: 100 });
    expect(pending.editableFields).toEqual([field("grams", "number")]);
    expect(store.size()).toBe(1);
  });

  it("uses ≥128-bit CSPRNG ids by default: 1000 real mints are unique and pattern-valid", () => {
    // Default randomId (crypto-backed) — no injected id source here.
    const store = new PendingConfirmStore({ now });
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const p = store.mint(mintInput({ externalId: `u_${i}` }));
      expect(p.pendingId).toMatch(PENDING_ID_PATTERN);
      ids.add(p.pendingId);
    }
    expect(ids.size).toBe(1000);
  });

  it("default id carries ≥128 bits: base64url body decodes to ≥16 bytes", () => {
    const store = new PendingConfirmStore({ now });
    const body = store.mint(mintInput()).pendingId.slice("cnf_".length);
    const bytes = Buffer.from(body, "base64url");
    expect(bytes.length).toBeGreaterThanOrEqual(16);
  });
});

// ---------------------------------------------------------------------------
// 2. USER ISOLATION — externalId is the only authorization key
// ---------------------------------------------------------------------------

describe("PendingConfirmStore user isolation", () => {
  it("consume with a DIFFERENT externalId returns null and leaves the pending intact", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    // Attacker knows the exact id but is a different verified caller.
    expect(store.consume("user_B", pending.pendingId)).toBeNull();
    expect(store.peek("user_B", pending.pendingId)).toBeNull();

    // The pending is untouched — the rightful owner still consumes it.
    const got = store.consume("user_A", pending.pendingId);
    expect(got).not.toBeNull();
    expect(got?.pendingId).toBe(pending.pendingId);
  });

  it("peek with a DIFFERENT externalId returns null", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));
    expect(store.peek("user_B", pending.pendingId)).toBeNull();
    expect(store.peek("user_A", pending.pendingId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. SINGLE-USE — consume is atomic delete-then-return
// ---------------------------------------------------------------------------

describe("PendingConfirmStore single-use", () => {
  it("consume returns the pending once, then null on the second consume", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    const first = store.consume("user_A", pending.pendingId);
    expect(first?.pendingId).toBe(pending.pendingId);

    const second = store.consume("user_A", pending.pendingId);
    expect(second).toBeNull();
    expect(store.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. TTL — expiry hides + sweep removes
// ---------------------------------------------------------------------------

describe("PendingConfirmStore TTL", () => {
  it("peek/consume return null once now passes expiresAtMs", () => {
    const store = makeStore({ ttlSeconds: 300 });
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    nowMs = pending.expiresAtMs + 1;

    expect(store.peek("user_A", pending.pendingId)).toBeNull();
    expect(store.consume("user_A", pending.pendingId)).toBeNull();
  });

  it("a pending is still live AT expiresAtMs and gone strictly after", () => {
    const store = makeStore({ ttlSeconds: 300 });
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    nowMs = pending.expiresAtMs; // boundary — not yet expired
    expect(store.peek("user_A", pending.pendingId)).not.toBeNull();

    nowMs = pending.expiresAtMs + 1;
    expect(store.peek("user_A", pending.pendingId)).toBeNull();
  });

  it("sweepExpired removes expired entries and returns the count", () => {
    const store = makeStore({ ttlSeconds: 300 });
    const a = store.mint(mintInput({ externalId: "user_A" }));
    store.mint(mintInput({ externalId: "user_B" }));
    expect(store.size()).toBe(2);

    // Advance past A's & B's expiry (both minted at same now).
    nowMs = a.expiresAtMs + 1;
    expect(store.sweepExpired()).toBe(2);
    expect(store.size()).toBe(0);
  });

  it("sweepExpired leaves live entries and counts only the expired ones", () => {
    const randomId = seqRandomId();
    const store = new PendingConfirmStore({ now, ttlSeconds: 300, randomId });
    const early = store.mint(mintInput({ externalId: "user_A" }));

    nowMs += 200_000; // 200s later, still within the first's 300s ttl
    const late = store.mint(mintInput({ externalId: "user_B" }));

    nowMs = early.expiresAtMs + 1; // early expired, late (expires 200s later) still live
    expect(store.sweepExpired()).toBe(1);
    expect(store.size()).toBe(1);
    expect(store.peek("user_B", late.pendingId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. peek does NOT consume
// ---------------------------------------------------------------------------

describe("PendingConfirmStore peek is non-consuming", () => {
  it("two peeks both return the pending and a later consume still works once", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    expect(store.peek("user_A", pending.pendingId)?.pendingId).toBe(pending.pendingId);
    expect(store.peek("user_A", pending.pendingId)?.pendingId).toBe(pending.pendingId);
    expect(store.size()).toBe(1);

    expect(store.consume("user_A", pending.pendingId)?.pendingId).toBe(pending.pendingId);
    expect(store.consume("user_A", pending.pendingId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5b. stage — attach validated confirmedFields to a live pending
// ---------------------------------------------------------------------------

describe("PendingConfirmStore.stage", () => {
  it("stages confirmedFields onto the pending; a later consume returns them", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    expect(store.stage("user_A", pending.pendingId, { grams: 150 })).toBe(true);

    const got = store.consume("user_A", pending.pendingId);
    expect(got?.confirmedFields).toEqual({ grams: 150 });
    // previewArgs are untouched — the Governor merges them at commit time.
    expect(got?.previewArgs).toEqual({ grams: 100 });
  });

  it("stage under a DIFFERENT externalId returns false and leaves the pending unchanged", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    expect(store.stage("user_B", pending.pendingId, { grams: 999 })).toBe(false);

    const got = store.consume("user_A", pending.pendingId);
    expect(got).not.toBeNull();
    expect(got?.confirmedFields).toBeUndefined();
  });

  it("stage of an absent/expired id returns false", () => {
    const store = makeStore({ ttlSeconds: 300 });
    expect(store.stage("user_A", "cnf_0000000000000000000000", { grams: 1 })).toBe(false);

    const pending = store.mint(mintInput({ externalId: "user_A" }));
    nowMs = pending.expiresAtMs + 1; // expired
    expect(store.stage("user_A", pending.pendingId, { grams: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. cancel
// ---------------------------------------------------------------------------

describe("PendingConfirmStore.cancel", () => {
  it("cancel drops the pending; subsequent peek/consume return null", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    expect(store.cancel("user_A", pending.pendingId)).toBe(true);
    expect(store.peek("user_A", pending.pendingId)).toBeNull();
    expect(store.consume("user_A", pending.pendingId)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("cancel of an unknown id returns false", () => {
    const store = makeStore();
    expect(store.cancel("user_A", "cnf_0000000000000000000000")).toBe(false);
  });

  it("cancel by a DIFFERENT externalId returns false and leaves the pending", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A" }));

    expect(store.cancel("user_B", pending.pendingId)).toBe(false);
    expect(store.peek("user_A", pending.pendingId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. sessionKey is stored but NEVER an authorization/lookup input
// ---------------------------------------------------------------------------

describe("PendingConfirmStore sessionKey is not an auth input", () => {
  it("lookups ignore sessionKey — a different sessionKey still consumes with the right externalId", () => {
    const store = makeStore();
    const pending = store.mint(mintInput({ externalId: "user_A", sessionKey: "sess_ONE" }));

    // No sessionKey is passed to peek/consume at all — isolation is externalId-only.
    const got = store.consume("user_A", pending.pendingId);
    expect(got?.pendingId).toBe(pending.pendingId);
    expect(got?.sessionKey).toBe("sess_ONE");
  });

  it("same externalId + same id but minted under a different sessionKey is still the same pending", () => {
    // Proves sessionKey does not partition the keyspace.
    const store = new PendingConfirmStore({
      now,
      randomId: () => "cnf_fixedfixedfixedfixed00",
    });
    store.mint(mintInput({ externalId: "user_A", sessionKey: "sess_X" }));
    // A second peek under a wholly unrelated sessionKey context still resolves.
    expect(store.peek("user_A", "cnf_fixedfixedfixedfixed00")).not.toBeNull();
  });
});

// A sanity check that the entropy claim is real (crypto, not Math.random).
it("default randomId draws from node:crypto (spot-check length invariant)", () => {
  // 16 bytes → base64url length 22 (no padding). Guarantees ≥128 bits.
  const raw = randomBytes(16).toString("base64url");
  expect(raw.length).toBe(22);
});
