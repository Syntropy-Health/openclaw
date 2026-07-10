/**
 * A4 PRODUCER BRIDGE — reserved tool-result marker → reply-payload channelData.
 *
 * Proves the focused, marked-only lift: a tool result carrying
 * `details.__openclaw_component` surfaces on the assistant payload's
 * `channelData` in exactly the `{ type: "component", component }` shape the
 * gateway consumer (B3) reads; without the marker the payloads are unchanged
 * (characterization) — the lift is behavior-preserving.
 */

import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads, extractComponentChannelData } from "./payloads.js";

const COMPONENT = {
  type: "component",
  key: "food_confirm",
  props: {},
  ui: { summary: "Log salmon, 340 kcal?", commit_tool: "syntropy_log_food" },
};

function markedToolResult(component: unknown = COMPONENT) {
  return {
    role: "toolResult",
    toolName: "analyze_food",
    details: { component, __openclaw_component: { type: "component", component } },
  };
}

type BuildParams = Parameters<typeof buildEmbeddedRunPayloads>[0];
const build = (overrides: Partial<BuildParams> = {}) =>
  buildEmbeddedRunPayloads({
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    sessionKey: "session:http",
    inlineToolResultsAllowed: false,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    ...overrides,
  });

describe("extractComponentChannelData", () => {
  it("lifts a valid marker into the channelData carrier shape", () => {
    const carrier = extractComponentChannelData([markedToolResult()]);
    expect(carrier).toEqual({ type: "component", component: COMPONENT });
  });

  it("returns undefined when there is no marker (behavior-preserving)", () => {
    expect(extractComponentChannelData(undefined)).toBeUndefined();
    expect(extractComponentChannelData([])).toBeUndefined();
    expect(
      extractComponentChannelData([{ role: "toolResult", details: { note: "no marker" } }]),
    ).toBeUndefined();
    expect(
      extractComponentChannelData([{ role: "assistant", details: markedToolResult().details }]),
    ).toBeUndefined();
  });

  it("ignores a marker with the wrong shape", () => {
    expect(
      extractComponentChannelData([
        { role: "toolResult", details: { __openclaw_component: { type: "not-component" } } },
      ]),
    ).toBeUndefined();
    expect(
      extractComponentChannelData([
        { role: "toolResult", details: { __openclaw_component: { type: "component" } } },
      ]),
    ).toBeUndefined();
  });

  it("is last-wins across multiple marked results", () => {
    const second = { ...COMPONENT, key: "second_confirm" };
    const carrier = extractComponentChannelData([
      markedToolResult(COMPONENT),
      markedToolResult(second),
    ]);
    expect(carrier).toEqual({ type: "component", component: second });
  });
});

describe("buildEmbeddedRunPayloads — component channelData lift", () => {
  it("attaches channelData to the assistant text payload when a tool result is marked", () => {
    const payloads = build({
      assistantTexts: ["Here's what I found — confirm?"],
      toolResultMessages: [markedToolResult()],
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Here's what I found — confirm?");
    expect(payloads[0]?.channelData).toEqual({ type: "component", component: COMPONENT });
  });

  it("attaches to the LAST non-error text payload", () => {
    const payloads = build({
      assistantTexts: ["first line", "second line"],
      toolResultMessages: [markedToolResult()],
    });
    expect(payloads[payloads.length - 1]?.channelData).toEqual({
      type: "component",
      component: COMPONENT,
    });
    // The earlier payload carries no channelData.
    expect(payloads[0]?.channelData).toBeUndefined();
  });

  it("attaches NO channelData when no tool result is marked (characterization)", () => {
    const withMessages = build({
      assistantTexts: ["Here's what I found — confirm?"],
      toolResultMessages: [{ role: "toolResult", details: { component: COMPONENT } }],
    });
    const withoutMessages = build({ assistantTexts: ["Here's what I found — confirm?"] });

    expect(withMessages[0]?.channelData).toBeUndefined();
    expect(withoutMessages[0]?.channelData).toBeUndefined();
    // Byte-identical to the no-messages build (no extra keys introduced).
    expect(withMessages).toEqual(withoutMessages);
  });
});
