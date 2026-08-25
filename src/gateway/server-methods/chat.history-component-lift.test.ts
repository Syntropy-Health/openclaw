/**
 * 2c-web — the chat.history COMPONENT LIFT (channel-tool-hooks A&D §2).
 *
 * History is the web UI's single render path (the final chat payload is
 * superseded by an immediate history reload), and the history sanitizer
 * strips `details` — so without this lift no descriptor could ever reach the
 * web renderer. These tests pin the lift's contract: a VALID Governor-stamped
 * carrier survives as `component`; everything else in details still dies;
 * invalid/absent markers lift nothing (fail-closed).
 */

import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat.js";

const VALID_COMPONENT = {
  type: "component",
  key: "food_log_card",
  props: {},
  ui: {
    summary: "Log 2 eggs (156 kcal)?",
    commit_tool: "log_food",
    cancel_tool: null,
    fields: [{ name: "food_name", label: "Food", type: "string", value: "eggs" }],
    pending_id: "cnf_0123456789abcdefghijkl",
    expires_at: "2030-01-01T00:00:00.000Z",
  },
};

function toolResultMessage(details: unknown) {
  return {
    role: "toolResult",
    content: [{ type: "text", text: "preview" }],
    details,
  };
}

describe("chat.history component lift (2c-web)", () => {
  it("lifts a VALID stamped carrier to `component` AND still strips details", () => {
    const [out] = sanitizeChatHistoryMessages([
      toolResultMessage({
        __openclaw_component: { type: "component", component: VALID_COMPONENT },
        secretInternal: "must not survive",
      }),
    ]) as Array<Record<string, unknown>>;

    expect(out.component).toEqual(VALID_COMPONENT);
    // The lift must not weaken the strip: details die entirely.
    expect("details" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("secretInternal");
  });

  it("an INVALID descriptor lifts NOTHING (fail-closed — same validator as the A4 bridge)", () => {
    const [out] = sanitizeChatHistoryMessages([
      toolResultMessage({
        __openclaw_component: { type: "component", component: { garbage: true } },
      }),
    ]) as Array<Record<string, unknown>>;

    expect(out.component).toBeUndefined();
    expect("details" in out).toBe(false);
  });

  it("a wrong-shaped marker (not the wire shape) lifts nothing", () => {
    const [out] = sanitizeChatHistoryMessages([
      toolResultMessage({ __openclaw_component: VALID_COMPONENT }), // missing carrier wrap
    ]) as Array<Record<string, unknown>>;
    expect(out.component).toBeUndefined();
  });

  it("details WITHOUT a marker sanitize exactly as before (no component field appears)", () => {
    const [out] = sanitizeChatHistoryMessages([toolResultMessage({ score: 82 })]) as Array<
      Record<string, unknown>
    >;
    expect("component" in out).toBe(false);
    expect("details" in out).toBe(false);
  });

  it("a NON-toolResult message never gains a component (assistant details are not a descriptor channel)", () => {
    const [out] = sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        details: { __openclaw_component: { type: "component", component: VALID_COMPONENT } },
      },
    ]) as Array<Record<string, unknown>>;
    expect("component" in out).toBe(false);
    expect("details" in out).toBe(false);
  });
});
