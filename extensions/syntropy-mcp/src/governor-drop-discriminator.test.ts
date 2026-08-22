/**
 * #6864 / #219 — the Governor drop DISCRIMINATOR, every arm observed firing.
 *
 * Measured reality this fixes (shrinemobile's C1 proof): four gateway states
 * collapsed to "zero component outputs" at the client, with no gateway log
 * line separating them — a real allowlist regression was indistinguishable
 * from correct gating, from a dead Governor, and from the tool never running.
 * Information destroyed at the collapse point cannot be recovered by client
 * assertions below it, so the discriminator is emitted AT the drop point.
 *
 * THE ACCEPTANCE BAR (CTO, verbatim): "Prove it with a RED arm: drop a tool
 * from commitTools and confirm the event names that tool and that reason. And
 * do not let the event fire only on the happy path." Both are tests below —
 * plus the inverse noise guards: the MINTED path emits nothing, and an
 * ordinary no-component tool result emits nothing (an event on every plain
 * result would train readers to ignore the channel).
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { ConfirmGovernor, type GovernorDropEvent } from "./governor.js";
import { PendingConfirmStore } from "./pending-confirm-store.js";

const VALID_DESCRIPTOR = {
  type: "component",
  key: "food_log_card",
  props: {},
  ui: {
    summary: "Log 2 eggs (156 kcal)?",
    commit_tool: "log_food",
    cancel_tool: null,
    fields: [{ name: "food_name", label: "Food", type: "string", value: "eggs" }],
  },
};

function resultWith(component: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: "preview" }], details: { component } };
}

function makeGovernor(opts: { allow?: string[] } = {}) {
  const drops: GovernorDropEvent[] = [];
  const store = new PendingConfirmStore();
  const governor = new ConfirmGovernor(store, {
    commitToolsByServer: new Map([["sj", new Set(opts.allow ?? ["log_food"])]]),
    onDrop: (e) => drops.push(e),
  });
  return { governor, drops };
}

const TURN = { externalId: "user_1", sessionKey: "s1", serverId: "sj" };

describe("#6864 — every drop arm names its reason (observed firing)", () => {
  it("RED ARM (the regression case): a tool dropped from commitTools → event names TOOL and REASON", () => {
    // Exactly the CTO's acceptance scenario: the allowlist no longer carries
    // the tool the descriptor declares.
    const { governor, drops } = makeGovernor({ allow: ["some_other_tool"] });

    const out = governor.preview({ toolResult: resultWith(VALID_DESCRIPTOR), ...TURN });

    expect(out).toBeNull();
    expect(drops).toEqual([
      { reason: "commit_tool_not_allowlisted", serverId: "sj", commitTool: "log_food" },
    ]);
  });

  it("descriptor present, commit_tool null → no_commit_tool (the legitimate degrade, still separable)", () => {
    const { governor, drops } = makeGovernor();
    const summaryShaped = {
      ...VALID_DESCRIPTOR,
      ui: { ...VALID_DESCRIPTOR.ui, commit_tool: null },
    };

    expect(governor.preview({ toolResult: resultWith(summaryShaped), ...TURN })).toBeNull();
    expect(drops).toEqual([{ reason: "no_commit_tool", serverId: "sj" }]);
  });

  it("identity unverified → event carries the reason AND the tool, never the identity", () => {
    const { governor, drops } = makeGovernor();

    const out = governor.preview({
      toolResult: resultWith(VALID_DESCRIPTOR),
      externalId: undefined,
      sessionKey: "whatsapp:+15551230042", // channel keys can embed E.164 — must never leak
      serverId: "sj",
    });

    expect(out).toBeNull();
    expect(drops).toEqual([
      { reason: "identity_unverified", serverId: "sj", commitTool: "log_food" },
    ]);
    // PHI/identifier hygiene: the event object must not smuggle the session key.
    expect(JSON.stringify(drops)).not.toContain("+15551230042");
  });

  it("component field present but schema-INVALID → invalid_descriptor", () => {
    const { governor, drops } = makeGovernor();

    expect(
      governor.preview({ toolResult: resultWith({ v: 999, garbage: true }), ...TURN }),
    ).toBeNull();
    expect(drops).toEqual([{ reason: "invalid_descriptor", serverId: "sj" }]);
  });
});

describe("#6864 — the noise guards (the event must not cry wolf)", () => {
  it("an ordinary tool result (NO component field) emits NOTHING", () => {
    // 9 of 10 tools return plain data. An event per plain result would flood
    // the channel into ignorability — absence of a component is the NORMAL
    // case, not a drop.
    const { governor, drops } = makeGovernor();

    expect(
      governor.preview({
        toolResult: { content: [{ type: "text", text: "score: 82" }], details: { score: 82 } },
        ...TURN,
      }),
    ).toBeNull();
    expect(drops).toEqual([]);
  });

  it("the MINTED path emits NO drop event (and does mint)", () => {
    const { governor, drops } = makeGovernor();

    const out = governor.preview({ toolResult: resultWith(VALID_DESCRIPTOR), ...TURN });

    expect(out).not.toBeNull();
    expect(out!.descriptor.ui.pending_id).toBeTruthy();
    expect(drops).toEqual([]);
  });
});
