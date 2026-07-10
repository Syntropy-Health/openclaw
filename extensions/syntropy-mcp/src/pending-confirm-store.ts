/**
 * PendingConfirmStore — the pending-confirmation state primitive for the B4
 * Confirmation Governor (preview-then-commit).
 *
 * When a user invokes a sensitive tool the Governor MINTS a pending (the
 * preview args + the editable-field spec), returns a confirmation descriptor,
 * and does NOT commit. On the user's confirm turn the Governor validates and
 * CONSUMES the pending and reconstructs the commit args server-side. This store
 * is the source of truth, so two properties are load-bearing and enforced here:
 *
 *  - USER ISOLATION: every lookup is scoped by `externalId` (the VERIFIED caller
 *    identity, e.g. the Clerk `sub`). A caller can never touch another user's
 *    pending even holding the exact `pendingId`. `sessionKey` is retained for UX
 *    routing ONLY and is never a lookup or authorization input.
 *  - SINGLE-USE: `consume` is atomic delete-then-return. In Node's single thread
 *    a double-consume cannot both succeed — the second returns null.
 *
 * ids are ≥128-bit CSPRNG (node:crypto), never backend-supplied, and match
 * PENDING_ID_PATTERN. The store owns NO timer — a plugin drives `sweepExpired`
 * (mirrors the catalog's "never self-schedule" rule); expired entries are also
 * treated as absent on read.
 */

import { randomBytes } from "node:crypto";
import {
  type ComponentFieldDescriptor,
  PENDING_ID_PATTERN,
} from "../../../src/gateway/component-descriptor.schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingConfirm = {
  /** "cnf_" + ≥128-bit CSPRNG (base64url); matches PENDING_ID_PATTERN. */
  pendingId: string;
  /** VERIFIED caller identity (e.g. Clerk sub) — the isolation key. */
  externalId: string;
  /** Retained for UX routing only, NOT an authorization input. */
  sessionKey: string;
  /** Canonical syntropy_* tool name the confirm will invoke. */
  commitTool: string;
  /** analyze/initiate args the Governor reconstructs the commit from. */
  previewArgs: Record<string, unknown>;
  /** ui.fields — the ONLY fields a user may override. */
  editableFields: ComponentFieldDescriptor[];
  expiresAtMs: number;
};

export type MintInput = {
  externalId: string;
  sessionKey: string;
  commitTool: string;
  previewArgs: Record<string, unknown>;
  editableFields: ComponentFieldDescriptor[];
};

export type PendingConfirmStoreOptions = {
  /** Pending lifetime in seconds. Default 300. */
  ttlSeconds?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
  /** Injectable id source for tests. Default: ≥128-bit CSPRNG (node:crypto). */
  randomId?: () => string;
};

const DEFAULT_TTL_SECONDS = 300;

/**
 * ≥128-bit entropy: 16 random bytes → base64url is 22 chars (unpadded), which
 * satisfies PENDING_ID_PATTERN's `{22,}` minimum. 16 bytes = 128 bits is the
 * floor; more bytes only strengthen it.
 */
const ID_ENTROPY_BYTES = 16;

function defaultRandomId(): string {
  return `cnf_${randomBytes(ID_ENTROPY_BYTES).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// PendingConfirmStore
// ---------------------------------------------------------------------------

export class PendingConfirmStore {
  // Keyed by pendingId. externalId is checked on every read so the id alone is
  // never sufficient to resolve another user's pending.
  private readonly pendings = new Map<string, PendingConfirm>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(opts?: PendingConfirmStoreOptions) {
    this.ttlMs = (opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.now = opts?.now ?? Date.now;
    this.randomId = opts?.randomId ?? defaultRandomId;
  }

  /** Mint + store a pending keyed by (externalId, pendingId). */
  mint(input: MintInput): PendingConfirm {
    const pendingId = this.randomId();
    if (!PENDING_ID_PATTERN.test(pendingId)) {
      // Fail-loud: a bad id source is a security defect, not a soft error.
      throw new Error(`PendingConfirmStore: generated pendingId does not match PENDING_ID_PATTERN`);
    }
    const pending: PendingConfirm = {
      pendingId,
      externalId: input.externalId,
      sessionKey: input.sessionKey,
      commitTool: input.commitTool,
      previewArgs: input.previewArgs,
      editableFields: input.editableFields,
      expiresAtMs: this.now() + this.ttlMs,
    };
    this.pendings.set(pendingId, pending);
    return pending;
  }

  /**
   * Look up WITHOUT consuming. Returns null if absent, expired, or the
   * externalId does not match the minter (user isolation).
   */
  peek(externalId: string, pendingId: string): PendingConfirm | null {
    return this.resolveLive(externalId, pendingId);
  }

  /**
   * Atomically consume: delete-then-return. Returns null if absent, expired, or
   * externalId-mismatch. A second consume of the same id returns null.
   */
  consume(externalId: string, pendingId: string): PendingConfirm | null {
    const pending = this.resolveLive(externalId, pendingId);
    if (pending === null) return null;
    this.pendings.delete(pendingId);
    return pending;
  }

  /** Drop the pending; true iff it existed AND is owned by externalId. */
  cancel(externalId: string, pendingId: string): boolean {
    const pending = this.pendings.get(pendingId);
    if (pending === undefined || pending.externalId !== externalId) return false;
    this.pendings.delete(pendingId);
    return true;
  }

  /** Remove all expired entries; returns the number removed. */
  sweepExpired(): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [pendingId, pending] of this.pendings) {
      if (this.isExpired(pending, nowMs)) {
        this.pendings.delete(pendingId);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.pendings.size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve a pending only when it exists, is owned by `externalId`, and is not
   * expired. An expired entry is treated as gone (but left for sweepExpired to
   * reclaim — reads must not depend on a prior sweep).
   */
  private resolveLive(externalId: string, pendingId: string): PendingConfirm | null {
    const pending = this.pendings.get(pendingId);
    if (pending === undefined) return null;
    if (pending.externalId !== externalId) return null;
    if (this.isExpired(pending, this.now())) return null;
    return pending;
  }

  private isExpired(pending: PendingConfirm, nowMs: number): boolean {
    return nowMs > pending.expiresAtMs;
  }
}
