import { describe, expect, it } from "vitest";
import type { ComponentDescriptor } from "../../gateway/component-descriptor.schema.js";
import {
  descriptorHasHealthContent,
  isThirdPartyChannel,
  KNOWN_THIRD_PARTY_CHANNELS,
  MINIMIZED_HEALTH_CONFIRM_TEXT,
  planChannelDataRender,
  planChannelRender,
  sanitizePhiApprovedChannels,
} from "./render-policy.js";

// A health-specific summary that MUST NOT leak to non-phiApproved channels.
const HEALTH_SUMMARY = "Log salmon meal — 340 cal, 34g protein";

function makeDescriptor(overrides?: {
  summary?: string;
  render?: "component" | "navigate" | "url";
  fields?: ComponentDescriptor["ui"]["fields"];
  pending_id?: string;
}): ComponentDescriptor {
  return {
    type: "component",
    key: "food_log_card",
    props: {},
    ...(overrides?.render ? { render: overrides.render } : {}),
    ui: {
      summary: overrides?.summary ?? HEALTH_SUMMARY,
      ...(overrides?.fields ? { fields: overrides.fields } : {}),
      ...(overrides?.pending_id
        ? { pending_id: overrides.pending_id, expires_at: "2030-01-01T00:00:00Z" }
        : {}),
    },
  };
}

const HEALTH_FIELDS: ComponentDescriptor["ui"]["fields"] = [
  { name: "calories", type: "number", value: 340, sensitivity: "health" },
  { name: "note", type: "string", sensitivity: "none" },
];
const NONE_FIELDS: ComponentDescriptor["ui"]["fields"] = [
  { name: "note", type: "string", sensitivity: "none" },
];

function assertNoHealthLeak(text: string) {
  expect(text).not.toContain(HEALTH_SUMMARY);
  expect(text).not.toContain("salmon");
  expect(text).not.toContain("340");
  expect(text).not.toContain("protein");
}

describe("descriptorHasHealthContent (helper — no longer the gate)", () => {
  it("is true when any field is sensitivity:health", () => {
    expect(descriptorHasHealthContent(makeDescriptor({ fields: HEALTH_FIELDS }))).toBe(true);
  });
  it("is false when all fields are sensitivity:none (characterization)", () => {
    expect(descriptorHasHealthContent(makeDescriptor({ fields: NONE_FIELDS }))).toBe(false);
  });
  it("is false when there are no fields (characterization)", () => {
    expect(descriptorHasHealthContent(makeDescriptor())).toBe(false);
  });
});

describe("planChannelRender — channel-keyed, fail-safe minimization", () => {
  it("SEC-1: component-render summary-only-health card on whatsapp (default) → MINIMIZED (no health fields present)", () => {
    // The SJ producer emits NO health-marked fields today; ui.summary carries the
    // macros. Old per-field gate would ship this to Meta — the channel-keyed gate
    // minimizes it.
    const descriptor = makeDescriptor({ render: "component", fields: NONE_FIELDS });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
    if (plan.kind === "text") {
      assertNoHealthLeak(plan.text);
    }
  });

  it("SEC-1: render:undefined card on whatsapp → MINIMIZED (presumed health)", () => {
    const descriptor = makeDescriptor(); // render undefined, no fields
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
  });

  it("FAIL-CLOSED: a health component on an ARBITRARY UNKNOWN channel → MINIMIZED (not last-permissive)", () => {
    // A brand-new channel name, in no config and no phiApprovedChannels, must
    // default to NO health egress.
    const descriptor = makeDescriptor({ render: "component", fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "some_future_channel");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
    if (plan.kind === "text") {
      assertNoHealthLeak(plan.text);
    }
  });

  it("render:navigate card on whatsapp → passes full ui.summary (positively non-health routing text)", () => {
    const descriptor = makeDescriptor({ render: "navigate", summary: "Go to your dashboard" });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: "Go to your dashboard", minimized: false });
  });

  it("render:url card on whatsapp → passes full ui.summary", () => {
    const descriptor = makeDescriptor({ render: "url", summary: "Open the link" });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: "Open the link", minimized: false });
  });

  it("render:navigate on an UNKNOWN channel → still passes summary (positively non-health is channel-independent)", () => {
    const descriptor = makeDescriptor({ render: "navigate", summary: "Go to your dashboard" });
    const plan = planChannelRender(descriptor, "some_future_channel");
    expect(plan).toEqual({ kind: "text", text: "Go to your dashboard", minimized: false });
  });

  it("phiApproved (non-third-party) channel + health content → full ui.summary", () => {
    const descriptor = makeDescriptor({ render: "component", fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "shrinemobile", {
      phiApprovedChannels: ["shrinemobile"],
    });
    expect(plan).toEqual({ kind: "text", text: HEALTH_SUMMARY, minimized: false });
  });

  it("deepLinkBase + pending_id → deep-link appended to the minimized text", () => {
    const descriptor = makeDescriptor({
      render: "component",
      pending_id: "cnf_abcdefghijklmnopqrstuvwx",
    });
    const plan = planChannelRender(descriptor, "whatsapp", {
      deepLinkBase: "https://app.shrine.test/confirm/",
    });
    const text = plan.kind === "text" ? plan.text : "";
    expect(text).toContain("https://app.shrine.test/confirm/cnf_abcdefghijklmnopqrstuvwx");
    expect(text.startsWith(MINIMIZED_HEALTH_CONFIRM_TEXT)).toBe(true);
    assertNoHealthLeak(text);
  });

  it("pending_id present but deepLinkBase absent → no link (missing branch)", () => {
    const descriptor = makeDescriptor({
      render: "component",
      pending_id: "cnf_abcdefghijklmnopqrstuvwx",
    });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
  });

  it("SEC-4: whatsapp in phiApprovedChannels is IGNORED (denylist wins) → still MINIMIZED", () => {
    const descriptor = makeDescriptor({ render: "component", fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "whatsapp", { phiApprovedChannels: ["whatsapp"] });
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
  });
});

describe("sanitizePhiApprovedChannels / isThirdPartyChannel (SEC-4 counsel-gate)", () => {
  it("all known third-party channels are denylisted", () => {
    for (const channel of KNOWN_THIRD_PARTY_CHANNELS) {
      expect(isThirdPartyChannel(channel)).toBe(true);
    }
  });
  it("strips denylisted entries, keeps first-party ones", () => {
    const { approved, ignored } = sanitizePhiApprovedChannels([
      "whatsapp",
      "shrinemobile",
      "slack",
      "webchat",
    ]);
    expect(approved).toEqual(["shrinemobile", "webchat"]);
    expect(ignored).toEqual(["whatsapp", "slack"]);
  });
  it("undefined config → empty approved (default: nothing approved)", () => {
    expect(sanitizePhiApprovedChannels(undefined)).toEqual({ approved: [], ignored: [] });
  });
});

describe("planChannelDataRender — fail-safe carrier decision", () => {
  const componentCarrier = (component: unknown) => ({ type: "component", component });

  it("non-component channelData → action none (untouched)", () => {
    expect(planChannelDataRender({ mode: "custom" }, "whatsapp")).toEqual({ action: "none" });
  });

  it("undefined channelData → action none", () => {
    expect(planChannelDataRender(undefined, "whatsapp")).toEqual({ action: "none" });
  });

  it("valid health component on whatsapp → scrub minimized", () => {
    const carrier = componentCarrier(makeDescriptor({ render: "component" }));
    const decision = planChannelDataRender(carrier, "whatsapp");
    expect(decision).toEqual({
      action: "scrub",
      text: MINIMIZED_HEALTH_CONFIRM_TEXT,
      minimized: true,
    });
  });

  it("SEC-2: malformed component (missing summary) → fail-safe scrub minimized (not passthrough)", () => {
    const malformed = componentCarrier({
      type: "component",
      key: "food_log_card",
      props: {},
      ui: {},
    });
    const decision = planChannelDataRender(malformed, "whatsapp");
    expect(decision).toEqual({
      action: "scrub",
      text: MINIMIZED_HEALTH_CONFIRM_TEXT,
      minimized: true,
    });
  });

  it("SEC-2: pending_id without expires_at (schema refine fails) → fail-safe scrub", () => {
    const malformed = componentCarrier({
      type: "component",
      key: "food_log_card",
      props: {},
      ui: { summary: HEALTH_SUMMARY, pending_id: "cnf_abcdefghijklmnopqrstuvwx" },
    });
    const decision = planChannelDataRender(malformed, "whatsapp");
    expect(decision.action).toBe("scrub");
    if (decision.action === "scrub") {
      expect(decision.text).toBe(MINIMIZED_HEALTH_CONFIRM_TEXT);
      assertNoHealthLeak(decision.text);
    }
  });

  it("nav component on whatsapp → scrub with full summary, not minimized", () => {
    const carrier = componentCarrier(
      makeDescriptor({ render: "navigate", summary: "Go to your dashboard" }),
    );
    expect(planChannelDataRender(carrier, "whatsapp")).toEqual({
      action: "scrub",
      text: "Go to your dashboard",
      minimized: false,
    });
  });
});
