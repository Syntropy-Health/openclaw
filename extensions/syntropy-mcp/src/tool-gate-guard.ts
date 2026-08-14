/**
 * ToolGate guard — the openclaw-side enforcement at tool-dispatch (ADR-0001
 * step-3). Composes the pieces: look up the tool's declared gate, evaluate it
 * against the built {@link GateContext}, and — for a `phi` tool — write the
 * durable audit BEFORE allowing. Registered as a second `before_tool_call` guard
 * alongside the Confirmation Governor (same block/undefined contract).
 *
 * This is the CLIENT leg; SJ re-evaluates server-side (defense-in-depth). Every
 * arrow fail-closed: malformed gate → deny; gate-fail → deny; phi with no audit
 * sink / no resolvable target / non-201 audit → deny (result never returns).
 */

import type { GateContext } from "./gate-context.js";
import type { PhiAuditClient, PhiAuditRecord } from "./phi-audit.js";
import { DEFAULT_GATE, evaluateGate, type Gate, gateRequiresPhiAudit } from "./tool-gate.js";

/** Mirrors the Governor's block/allow contract (`{block, blockReason}` | undefined). */
export type ToolGateGuardResult = { block: true; blockReason: string } | undefined;

export type PhiAuditDep = {
  client: PhiAuditClient;
  /** Extract the target clerk_id being read from the tool params. Returns undefined → deny (can't audit blind). */
  resolveTargetClerkId: (params: unknown) => string | undefined;
  /** ISO timestamp source (injectable for tests). */
  nowIso: () => string;
};

export type ToolGateGuardDeps = {
  /**
   * Resolve the tool's declared gate:
   *  - a {@link Gate} → the parsed effective-gate,
   *  - `null` → the annotation was PRESENT but malformed → DENY,
   *  - `undefined` → NO annotation → {@link DEFAULT_GATE} (auth_required floor).
   */
  resolveGate: (toolName: string) => Gate | null | undefined;
  gateContext: GateContext;
  /** Present only when phi enforcement is wired. Absent + a phi tool → deny (fail-closed). */
  phiAudit?: PhiAuditDep;
  logger?: { warn?: (m: string) => void };
};

function block(reason: string): ToolGateGuardResult {
  return { block: true, blockReason: reason };
}

/**
 * Evaluate the gate for `toolName` against the context; block or allow.
 * `params` is the tool-call params (used only to resolve the audit target).
 */
export async function toolGateGuard(
  toolName: string,
  params: unknown,
  deps: ToolGateGuardDeps,
): Promise<ToolGateGuardResult> {
  const raw = deps.resolveGate(toolName);
  // ABSENT (undefined) → auth_required floor; MALFORMED (null) → deny.
  if (raw === null) {
    deps.logger?.warn?.(`tool-gate: '${toolName}' gate malformed → deny (fail-closed)`);
    return block("tool gate malformed — denied");
  }
  const gate: Gate = raw ?? DEFAULT_GATE;

  const decision = evaluateGate(gate, deps.gateContext);
  if (!decision.allowed) {
    return block(`${decision.failing_kind ?? "gate"} denied`);
  }

  // PHI tools: the audit is a SEPARATE hard gate — durable insert BEFORE allowing.
  if (gateRequiresPhiAudit(gate)) {
    if (!deps.phiAudit) {
      deps.logger?.warn?.(`tool-gate: '${toolName}' is phi but no audit sink configured → deny`);
      return block("phi tool — audit sink not configured — denied");
    }
    const targetClerkId = deps.phiAudit.resolveTargetClerkId(params);
    if (!targetClerkId) {
      deps.logger?.warn?.(
        `tool-gate: '${toolName}' phi tool with no resolvable target clerk_id → deny`,
      );
      return block("phi tool — no target clerk_id — denied");
    }
    const record: PhiAuditRecord = {
      admin_subject: deps.gateContext.admin_subject ?? deps.gateContext.user_subject ?? "",
      target_clerk_id: targetClerkId,
      tool: toolName,
      ts: deps.phiAudit.nowIso(),
    };
    const audit = await deps.phiAudit.client.write(record);
    if (!audit.ok) {
      return block("phi audit write failed — denied");
    }
  }

  return undefined; // allow — the call proceeds; GateContext also travels to SJ (server-side re-eval).
}
