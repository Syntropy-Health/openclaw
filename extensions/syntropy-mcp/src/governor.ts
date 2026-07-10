/**
 * ConfirmGovernor — the B4 preview-then-commit security kernel for syntropy-mcp.
 *
 * The A&D's lone CRITICAL is commit-arg binding: a mutating `syntropy_*` commit
 * tool must NEVER run with args the model chose. The flow is three server-owned
 * stages, each a method here, all fail-closed:
 *
 *  T4.2 PREVIEW  (preview) — after an INITIATE tool (e.g. analyze_food) returns a
 *    ComponentDescriptor whose `ui.commit_tool` is allowlisted, the Governor
 *    MINTS a single-use pending (previewArgs = the values the user saw) and
 *    stamps a gateway-minted `pending_id` + `expires_at` onto the descriptor.
 *    No allowlisted commit_tool / no verified identity ⇒ no pending (summary-only).
 *
 *  T4.3 CONFIRM  (parseConfirmTurn) — a deterministic, NON-LLM grammar parses the
 *    user's raw `<CONFIRM pending_id=… fields={…}>` turn, re-validates every edit
 *    against the pending's editable-field constraints server-side, and STAGES the
 *    validated overrides. Any unknown key / constraint violation / read-only edit
 *    is rejected and nothing is staged.
 *
 *  T4.4 COMMIT GUARD (guardBeforeToolCall) — THE CRIT FIX. A commit tool only
 *    runs against a valid single-use pending; the Governor CONSUMES it and
 *    RECONSTRUCTS the params as previewArgs ⊕ (confirmedFields restricted to the
 *    editable field names), DISCARDING the model-supplied params entirely (except
 *    the pending_id it extracts). No/stale/replayed/cross-user pending ⇒ BLOCK.
 *
 * SECURITY PROPERTIES (each a red-first test in governor.test.ts):
 *  1. Confirmed-X-committed-Y is impossible — committed args are always the
 *     reconstructed set, never the model's.
 *  2. No pending ⇒ block (a hallucinated direct commit is refused).
 *  3. Replay blocked — consume is single-use.
 *  4. Cross-user blocked — the store isolates pendings by externalId.
 *  5. Edit validation — non-editable / out-of-constraint / read-only edits do not
 *     stage.
 *  6. Non-LLM parse — the grammar runs on the raw string only.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ComponentDescriptor,
  type ComponentFieldDescriptor,
  parseComponentDescriptor,
} from "../../../src/gateway/component-descriptor.schema.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
} from "../../../src/plugins/types.js";
import type { PendingConfirmStore } from "./pending-confirm-store.js";

// ---------------------------------------------------------------------------
// Grammar — deterministic, first-line-only, no model in the loop
// ---------------------------------------------------------------------------

/** `<CONFIRM pending_id=<id> fields=<json-object>>` — captures id + raw json. */
const CONFIRM_RE = /^<CONFIRM pending_id=(\S+) fields=(\{.*\})>$/;
/** `<CANCEL pending_id=<id>>`. */
const CANCEL_RE = /^<CANCEL pending_id=(\S+)>$/;

/** User-facing block reason — never leaks pending internals. */
const BLOCK_REASON =
  "This action needs confirmation. Preview it first, then send the confirmation " +
  "so the gateway can bind the exact reviewed values.";

export type ConfirmGovernorOptions = {
  /** serverId → its allowlisted commit-tool names (the B1 per-server allowlist). */
  commitToolsByServer: Map<string, Set<string>>;
  /** Present for parity with the store's injectable clock; unused here today. */
  now?: () => number;
};

export type PreviewParams = {
  toolResult: AgentToolResult<unknown>;
  externalId: string | undefined;
  sessionKey: string;
  serverId: string;
};

export type ConfirmTurnResult = {
  /** True when the turn WAS a CONFIRM/CANCEL directive (a side effect ran). */
  handled: boolean;
  /** Soft re-prompt note (e.g. the pending expired / was already used). */
  note?: string;
  /** Hard validation error (bad edit); nothing was staged. */
  error?: string;
};

export class ConfirmGovernor {
  private readonly store: PendingConfirmStore;
  private readonly commitToolsByServer: Map<string, Set<string>>;

  constructor(store: PendingConfirmStore, opts: ConfirmGovernorOptions) {
    this.store = store;
    this.commitToolsByServer = opts.commitToolsByServer;
  }

  // -------------------------------------------------------------------------
  // T4.2 PREVIEW
  // -------------------------------------------------------------------------

  /**
   * Mint a pending + stamp the confirmation descriptor when an initiate tool's
   * result carries an allowlisted ComponentDescriptor. Returns null (no gating
   * capability, descriptor renders summary-only) when: the result has no valid
   * descriptor; `ui.commit_tool` is null/absent or NOT in the owning server's
   * allowlist; or there is no verified `externalId` (fail-closed — a confirm is
   * impossible without an isolation identity).
   */
  preview(params: PreviewParams): { descriptor: ComponentDescriptor } | null {
    const descriptor = readDescriptor(params.toolResult);
    if (!descriptor) return null;

    const commitTool = descriptor.ui.commit_tool;
    if (!commitTool) return null; // summary-only descriptor (no commit capability)

    const allow = this.commitToolsByServer.get(params.serverId);
    if (!allow || !allow.has(commitTool)) return null; // not allowlisted ⇒ no gating

    // Fail-closed: without a verified caller identity the pending could never be
    // isolated or confirmed, so no pending is minted (descriptor stays inert).
    if (!params.externalId) return null;

    const editableFields = descriptor.ui.fields ?? [];
    const previewArgs = previewArgsFromFields(editableFields);

    const pending = this.store.mint({
      externalId: params.externalId,
      sessionKey: params.sessionKey,
      commitTool,
      previewArgs,
      editableFields,
    });

    // Stamp the gateway-minted pending_id + expiry onto a COPY, then re-parse so
    // the stamped descriptor is provably schema-valid before it leaves the gate.
    const stampedRaw = {
      ...descriptor,
      ui: {
        ...descriptor.ui,
        pending_id: pending.pendingId,
        expires_at: new Date(pending.expiresAtMs).toISOString(),
      },
    };
    const stamped = parseComponentDescriptor(stampedRaw);
    if (!stamped) {
      // Defensive: a stamp that will not re-validate is a defect — drop the
      // pending rather than emit an ungated descriptor with a live pending.
      this.store.cancel(pending.externalId, pending.pendingId);
      return null;
    }
    return { descriptor: stamped };
  }

  // -------------------------------------------------------------------------
  // T4.3 CONFIRM PARSE
  // -------------------------------------------------------------------------

  /**
   * Parse the user's raw turn (FIRST LINE ONLY) for a CONFIRM/CANCEL directive.
   * Purely string-driven — no LLM. A non-directive turn returns
   * `{ handled: false }` so the normal agent turn proceeds unchanged.
   */
  parseConfirmTurn(prompt: string, externalId: string | undefined): ConfirmTurnResult {
    const line = firstLine(prompt);

    const cancelMatch = CANCEL_RE.exec(line);
    if (cancelMatch) {
      const pendingId = cancelMatch[1];
      if (externalId) this.store.cancel(externalId, pendingId);
      return { handled: true };
    }

    const confirmMatch = CONFIRM_RE.exec(line);
    if (!confirmMatch) return { handled: false };

    const pendingId = confirmMatch[1];
    const fieldsJson = confirmMatch[2];

    // Fail-closed: a confirm from an unverified caller can never be isolated.
    if (!externalId) return { handled: true, error: "no verified identity for confirm" };

    const pending = this.store.peek(externalId, pendingId);
    if (!pending) {
      return { handled: true, note: "That confirmation has expired or was already used." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fieldsJson);
    } catch {
      return { handled: true, error: "confirm fields is not valid JSON" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { handled: true, error: "confirm fields must be a JSON object" };
    }

    const byName = new Map(pending.editableFields.map((f) => [f.name, f]));
    const validated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const field = byName.get(key);
      // Unknown key: not in the editable set the user was shown ⇒ reject wholesale.
      if (!field) return { handled: true, error: `field "${key}" is not editable` };
      const err = validateFieldValue(field, value);
      if (err) return { handled: true, error: err };
      validated[key] = value;
    }

    const staged = this.store.stage(externalId, pendingId, validated);
    if (!staged) {
      // Raced with expiry/cancel between peek and stage.
      return { handled: true, note: "That confirmation is no longer available." };
    }
    return { handled: true };
  }

  // -------------------------------------------------------------------------
  // T4.4 COMMIT GUARD — the CRIT fix
  // -------------------------------------------------------------------------

  /**
   * Gate a tool call. Read (non-commit) tools pass through untouched (returns
   * undefined). A commit tool runs ONLY against a valid single-use pending it
   * owns; the Governor consumes the pending and RECONSTRUCTS the params from
   * previewArgs ⊕ (confirmedFields ∩ editableFields), discarding the model's
   * params. Missing/mismatched/replayed/cross-user pending ⇒ block.
   */
  guardBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    externalId: string | undefined,
  ): PluginHookBeforeToolCallResult | undefined {
    if (!this.isCommitTool(event.toolName)) return undefined;

    const pendingId = extractPendingId(event.params);
    if (!externalId || !pendingId) {
      return { block: true, blockReason: BLOCK_REASON };
    }

    // Single-use: delete-then-return BEFORE the tool proceeds, so a replay of the
    // same pending_id finds nothing. Consuming under the caller's externalId also
    // enforces cross-user isolation (the store rejects a foreign owner).
    const pending = this.store.consume(externalId, pendingId);
    if (!pending) {
      return { block: true, blockReason: BLOCK_REASON };
    }

    // The pending must belong to THIS commit tool — a pending minted for tool A
    // may not be spent binding a call to tool B.
    if (pending.commitTool !== event.toolName) {
      return { block: true, blockReason: BLOCK_REASON };
    }

    const editableNames = new Set(pending.editableFields.map((f) => f.name));
    const overrides: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pending.confirmedFields ?? {})) {
      // Belt-and-braces: only editable fields may override, even though the
      // stage step already validated against exactly this set.
      if (editableNames.has(key)) overrides[key] = value;
    }

    // Reconstructed server-side: previewArgs the user reviewed, overridden only
    // by the validated edits. The model-supplied params (incl. pending_id) are
    // discarded — this is the commit-arg binding guarantee.
    const reconstructed = { ...pending.previewArgs, ...overrides };
    return { params: reconstructed };
  }

  private isCommitTool(toolName: string): boolean {
    for (const set of this.commitToolsByServer.values()) {
      if (set.has(toolName)) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The initiate tool carries the C1 descriptor under `result.details.component`. */
function readDescriptor(result: AgentToolResult<unknown>): ComponentDescriptor | null {
  const details = result.details;
  if (!details || typeof details !== "object") return null;
  const raw = (details as Record<string, unknown>).component;
  return parseComponentDescriptor(raw);
}

/**
 * previewArgs = the field name → value map from `descriptor.ui.fields`: the
 * analyzed/previewed values the user saw. confirmedFields override a subset of
 * these at commit time. Fields without a value contribute nothing.
 */
function previewArgsFromFields(fields: ComponentFieldDescriptor[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.value !== undefined) out[field.name] = field.value;
  }
  return out;
}

function firstLine(prompt: string): string {
  const idx = prompt.search(/\r?\n/);
  const head = idx === -1 ? prompt : prompt.slice(0, idx);
  return head.trim();
}

function extractPendingId(params: Record<string, unknown> | undefined): string | undefined {
  const raw = params?.pending_id;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Re-validate a single user edit against the field's declared constraints
 * (client checks are UX-only; THIS is the authoritative check). Returns an error
 * string when the edit is rejected, or null when it passes. A read-only field
 * rejects ANY edit.
 */
function validateFieldValue(field: ComponentFieldDescriptor, value: unknown): string | null {
  const c = field.constraints;
  if (c?.readOnly === true) return `field "${field.name}" is read-only and cannot be edited`;

  switch (field.type) {
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `field "${field.name}" must be a number`;
      }
      if (field.type === "integer" && !Number.isInteger(value)) {
        return `field "${field.name}" must be an integer`;
      }
      if (c?.min !== undefined && value < c.min) {
        return `field "${field.name}" must be ≥ ${c.min}`;
      }
      if (c?.max !== undefined && value > c.max) {
        return `field "${field.name}" must be ≤ ${c.max}`;
      }
      if (c?.step !== undefined && c.step > 0) {
        const base = c.min ?? 0;
        const ratio = (value - base) / c.step;
        if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
          return `field "${field.name}" must align to step ${c.step}`;
        }
      }
      if (c?.options && !c.options.includes(value)) {
        return `field "${field.name}" is not an allowed option`;
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return `field "${field.name}" must be a string`;
      if (c?.maxLength !== undefined && value.length > c.maxLength) {
        return `field "${field.name}" exceeds maxLength ${c.maxLength}`;
      }
      if (c?.pattern !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(c.pattern);
        } catch {
          return `field "${field.name}" has an invalid pattern constraint`;
        }
        if (!re.test(value)) return `field "${field.name}" does not match the required pattern`;
      }
      if (c?.options && !c.options.includes(value)) {
        return `field "${field.name}" is not an allowed option`;
      }
      return null;
    }
    case "boolean": {
      if (typeof value !== "boolean") return `field "${field.name}" must be a boolean`;
      return null;
    }
    case "enum": {
      if (typeof value !== "string" && typeof value !== "number") {
        return `field "${field.name}" must be a string or number`;
      }
      if (!c?.options || !c.options.includes(value)) {
        return `field "${field.name}" is not an allowed option`;
      }
      return null;
    }
    case "photo": {
      // Photo fields are captured out-of-band, never edited via a confirm text.
      return `field "${field.name}" cannot be edited in a confirmation`;
    }
    default: {
      return `field "${field.name}" has an unsupported type`;
    }
  }
}
