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
 *    No allowlisted commit_tool / no verified identity ⇒ no pending AND no
 *    component output at all (the model's prose is the only surface — an
 *    unstamped descriptor is never emitted); each drop arm reports WHY via
 *    the required onDrop discriminator (#6864).
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

/** ReDoS caps (CWE-1333) for a backend-controlled `pattern` constraint. */
const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERN_TEST_LENGTH = 4096;

/** User-facing block reason — never leaks pending internals. */
const BLOCK_REASON =
  "This action needs confirmation. Preview it first, then send the confirmation " +
  "so the gateway can bind the exact reviewed values.";

/**
 * WHY a descriptor produced no confirm card — the upstream DISCRIMINATOR
 * (CTO directive #6864, measured by shrinemobile's C1 proof): four gateway
 * states collapse to "zero component outputs" at the client, so a real
 * allowlist regression is indistinguishable from correct gating, from a dead
 * Governor, and from the tool never running. Information destroyed at this
 * seam cannot be recovered by client-side assertions below it — so it is
 * emitted HERE, at the drop point.
 *
 * Reasons (each a distinct, greppable state):
 *  - "invalid_descriptor": a `component` field was PRESENT on the tool result
 *    but failed schema parse. (An ordinary tool result with NO component field
 *    emits NOTHING — 9 of 10 tools are plain data; an event on every one would
 *    be noise that trains readers to ignore the channel.)
 *  - "no_commit_tool": valid descriptor, `ui.commit_tool` null/absent — the
 *    legitimate summary-shaped degrade.
 *  - "commit_tool_not_allowlisted": THE REGRESSION CASE — a tool dropped from
 *    `commitTools` is exactly this event, naming the tool.
 *  - "identity_unverified": no verified externalId on the turn.
 *  - "stamp_revalidation_failed": defensive — a minted stamp failed re-parse;
 *    the pending was cancelled rather than emitting an ungated descriptor.
 *  - "nav_tool_not_allowlisted": THE NAV REGRESSION CASE (channel-tool-hooks
 *    A&D §4) — a `render: navigate|url` descriptor from a tool absent from
 *    the per-server `navTools` allowlist, naming the CALLING tool. The
 *    ALLOWLISTED nav path emits NOTHING (designed-path silence, like the
 *    no-component case): "by design" is distinguished from "unexpected" by
 *    silence-plus-rendered-card vs a logged arm — CTO 7148/7155.
 *
 * PHI/identifier hygiene: the event carries reason + serverId + commit-tool
 * name ONLY — never the sessionKey (channel session keys can embed peer
 * identifiers such as E.164 numbers), never the externalId, never field
 * values.
 */
export type GovernorDropReason =
  | "invalid_descriptor"
  | "no_commit_tool"
  | "commit_tool_not_allowlisted"
  | "identity_unverified"
  | "stamp_revalidation_failed"
  | "nav_tool_not_allowlisted";

export type GovernorDropEvent = {
  reason: GovernorDropReason;
  serverId: string;
  /** The commit tool involved, when the descriptor declared one. */
  commitTool?: string;
  /** nav_tool_not_allowlisted only: the CALLING tool (wire name) that emitted a nav descriptor. */
  navTool?: string;
};

export type ConfirmGovernorOptions = {
  /** serverId → its allowlisted commit-tool names (the B1 per-server allowlist). */
  commitToolsByServer: Map<string, Set<string>>;
  /**
   * serverId → tools allowed to emit `render: navigate|url` descriptors
   * (channel-tool-hooks §4). REQUIRED like its sibling: an omittable nav gate
   * would be the silent-by-default class. Empty set = no nav tools (fail-closed).
   */
  navToolsByServer: Map<string, Set<string>>;
  /**
   * REQUIRED drop reporter — deliberately not optional and not defaulted: a
   * silent-by-default observability channel is the defect this exists to fix
   * (an event that can be omitted will be, and its absence looks identical to
   * nothing-to-report). Tests that are not about drops pass a noop CONSCIOUSLY.
   */
  onDrop: (event: GovernorDropEvent) => void;
  /** Present for parity with the store's injectable clock; unused here today. */
  now?: () => number;
};

export type PreviewParams = {
  toolResult: AgentToolResult<unknown>;
  externalId: string | undefined;
  sessionKey: string;
  serverId: string;
  /** The CALLING tool's wire name — keys the navTools allowlist (§4). */
  toolName: string;
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
  private readonly navToolsByServer: Map<string, Set<string>>;
  private readonly onDrop: (event: GovernorDropEvent) => void;

  constructor(store: PendingConfirmStore, opts: ConfirmGovernorOptions) {
    this.store = store;
    this.commitToolsByServer = opts.commitToolsByServer;
    this.navToolsByServer = opts.navToolsByServer;
    this.onDrop = opts.onDrop;
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
    const read = readDescriptor(params.toolResult);
    if (read.kind === "absent") return null; // ordinary result — no event (see GovernorDropReason)
    if (read.kind === "invalid") {
      this.onDrop({ reason: "invalid_descriptor", serverId: params.serverId });
      return null;
    }
    const descriptor = read.descriptor;

    // NAV MODES (channel-tool-hooks §4): navigate/url descriptors are
    // NON-MUTATING — not the Governor's confirm business. No pending, no
    // stamp; the gateway marker alone is the attestation (SEC-FORGE-MARKER
    // guarantees only the gateway attaches it, so a backend still cannot
    // smuggle a nav card). Authorization mirrors commitTools: the CALLING
    // tool must be nav-allowlisted, or the drop is the NAMED regression arm.
    // The ALLOWLISTED path emits NO event — designed-path silence (the #219
    // noise rule); "by design" reads as silence + a rendered card,
    // "unexpected" reads as a logged arm. CTO 7148/7155.
    if (descriptor.render === "navigate" || descriptor.render === "url") {
      const navAllow = this.navToolsByServer.get(params.serverId);
      if (!navAllow || !navAllow.has(params.toolName)) {
        this.onDrop({
          reason: "nav_tool_not_allowlisted",
          serverId: params.serverId,
          navTool: params.toolName,
        });
        return null;
      }
      return { descriptor };
    }

    const commitTool = descriptor.ui.commit_tool;
    if (!commitTool) {
      // Degrade = NO component output; the model's prose is the only surface.
      // An unstamped descriptor is never emitted (it would be a forgeable
      // client-side surface). #219 item 2: the old "summary-only" wording here
      // was misread as "an unstamped summary CARD arrives" — it does not.
      this.onDrop({ reason: "no_commit_tool", serverId: params.serverId });
      return null;
    }

    const allow = this.commitToolsByServer.get(params.serverId);
    if (!allow || !allow.has(commitTool)) {
      // THE REGRESSION CASE (#6864): a tool dropped from commitTools lands
      // here — the event names the tool so the regression is greppable.
      this.onDrop({
        reason: "commit_tool_not_allowlisted",
        serverId: params.serverId,
        commitTool,
      });
      return null;
    }

    // Fail-closed: without a verified caller identity the pending could never be
    // isolated or confirmed, so no pending is minted (descriptor stays inert).
    if (!params.externalId) {
      this.onDrop({ reason: "identity_unverified", serverId: params.serverId, commitTool });
      return null;
    }

    const editableFields = descriptor.ui.fields ?? [];
    const previewArgs = previewArgsFromFields(editableFields);

    const pending = this.store.mint({
      externalId: params.externalId,
      sessionKey: params.sessionKey,
      serverId: params.serverId,
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
      this.onDrop({
        reason: "stamp_revalidation_failed",
        serverId: params.serverId,
        commitTool,
      });
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
    // Resolve the SURFACED tool name (the catalog prefixes cross-server name
    // collisions as "<serverId>:<wireName>") back to (serverId, wireName). A
    // non-commit tool resolves to null and passes through untouched. Keying on
    // the raw config name here would fail OPEN for a collision-prefixed commit
    // tool — the whole point of this gate.
    const resolved = this.resolveCommitTool(event.toolName);
    if (!resolved) return undefined;

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
    // may not be spent binding a call to tool B. Compare against the resolved
    // WIRE name so a collision-prefixed surfaced name still matches its pending.
    if (pending.commitTool !== resolved.wireName) {
      return { block: true, blockReason: BLOCK_REASON };
    }

    // Server binding: a pending minted on server A must not be spent against a
    // same-named commit tool the catalog surfaced (prefixed) on server B — that
    // would route the reviewed PHI write to the wrong backend. Enforced only when
    // the pending recorded its origin server (the preview path always does).
    if (pending.serverId !== undefined && pending.serverId !== resolved.serverId) {
      return { block: true, blockReason: BLOCK_REASON };
    }

    // Fail-closed: a commit requires a completed confirm turn. `stage` records
    // confirmedFields (at least `{}` for confirm-as-previewed); an UNDEFINED set
    // means no valid confirm was parsed (e.g. an invalid edit staged nothing) —
    // never silently commit the un-edited preview values in that case.
    if (pending.confirmedFields === undefined) {
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

  /**
   * True when `toolName` (a SURFACED name) resolves to a gated commit tool.
   * Shared with the plugin's fail-closed catch so both key on the surfaced name.
   */
  isGatedCommitTool(toolName: string): boolean {
    return this.resolveCommitTool(toolName) !== null;
  }

  /**
   * Map a SURFACED tool name back to its owning (serverId, wireName). The catalog
   * surfaces a cross-server name collision as `${serverId}:${wireName}`; an
   * uncollided tool surfaces under its bare wire name. Resolution tries the
   * prefixed interpretation first (a registered serverId whose allowlist holds
   * the suffix), then the bare interpretation (the first server whose allowlist
   * holds the whole name — which mirrors the catalog's first-server-wins surface
   * for the unprefixed variant). Returns null for a non-commit tool.
   */
  private resolveCommitTool(toolName: string): { serverId: string; wireName: string } | null {
    const sep = toolName.indexOf(":");
    if (sep > 0) {
      const serverId = toolName.slice(0, sep);
      const wireName = toolName.slice(sep + 1);
      if (this.commitToolsByServer.get(serverId)?.has(wireName)) {
        return { serverId, wireName };
      }
    }
    for (const [serverId, set] of this.commitToolsByServer) {
      if (set.has(toolName)) return { serverId, wireName: toolName };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The initiate tool carries the C1 descriptor under `result.details.component`. */
type ReadDescriptorResult =
  | { kind: "absent" } // no `component` key at all — the ordinary tool result
  | { kind: "invalid" } // `component` key PRESENT (even explicitly null) but not a valid descriptor
  | { kind: "ok"; descriptor: ComponentDescriptor };

function readDescriptor(result: AgentToolResult<unknown>): ReadDescriptorResult {
  const details = result.details;
  if (!details || typeof details !== "object") return { kind: "absent" };
  if (!("component" in details)) return { kind: "absent" };
  // An EXPLICIT `component: null` is a present key that parses to nothing — a
  // backend that used to emit descriptors and regressed to null lands here,
  // and must be greppable rather than reproducing the silent collapse (QG5 F5).
  const raw = (details as Record<string, unknown>).component;
  if (raw === undefined || raw === null) return { kind: "invalid" };
  const descriptor = parseComponentDescriptor(raw);
  return descriptor ? { kind: "ok", descriptor } : { kind: "invalid" };
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

/**
 * The first NON-EMPTY line (trimmed). Leading blank lines are skipped so a
 * confirm directive preceded by whitespace-only lines is still recognised; only
 * that single line is ever parsed (the directive grammar is one-line).
 */
function firstLine(prompt: string): string {
  for (const raw of prompt.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  return "";
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
        // ReDoS guard (CWE-1333): the pattern is BACKEND-controlled and could be
        // catastrophic-backtracking. Cap the pattern source AND the tested value
        // length UNCONDITIONALLY — independent of whether the backend set
        // maxLength — before compiling or testing, so a malicious pattern/value
        // can never stall the event loop.
        if (c.pattern.length > MAX_PATTERN_LENGTH) {
          return `field "${field.name}" has an invalid pattern constraint`;
        }
        if (value.length > MAX_PATTERN_TEST_LENGTH) {
          return `field "${field.name}" is too long to validate against the pattern`;
        }
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
