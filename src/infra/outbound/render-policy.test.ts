import { describe, expect, it } from "vitest";
import type { ComponentDescriptor } from "../../gateway/component-descriptor.schema.js";
import {
  descriptorHasHealthContent,
  MINIMIZED_HEALTH_CONFIRM_TEXT,
  planChannelRender,
} from "./render-policy.js";

// A health-specific summary that MUST NOT leak to non-phiApproved channels.
const HEALTH_SUMMARY = "Log salmon meal — 340 cal, 34g protein";

function makeDescriptor(overrides?: {
  summary?: string;
  fields?: ComponentDescriptor["ui"]["fields"];
  pending_id?: string;
}): ComponentDescriptor {
  return {
    type: "component",
    key: "food_log_card",
    props: {},
    ui: {
      summary: overrides?.summary ?? HEALTH_SUMMARY,
      ...(overrides?.fields ? { fields: overrides.fields } : {}),
      ...(overrides?.pending_id ? { pending_id: overrides.pending_id } : {}),
    },
  };
}

const HEALTH_FIELDS: ComponentDescriptor["ui"]["fields"] = [
  { name: "calories", type: "number", sensitivity: "health" },
  { name: "note", type: "string", sensitivity: "none" },
];
const NONE_FIELDS: ComponentDescriptor["ui"]["fields"] = [
  { name: "note", type: "string", sensitivity: "none" },
];

describe("descriptorHasHealthContent", () => {
  it("is true when any field is sensitivity:health", () => {
    expect(descriptorHasHealthContent(makeDescriptor({ fields: HEALTH_FIELDS }))).toBe(true);
  });

  it("is false when all fields are sensitivity:none", () => {
    expect(descriptorHasHealthContent(makeDescriptor({ fields: NONE_FIELDS }))).toBe(false);
  });

  it("is false when there are no fields", () => {
    expect(descriptorHasHealthContent(makeDescriptor())).toBe(false);
  });
});

describe("planChannelRender", () => {
  it("(a) phiApproved channel + health content → full ui.summary", () => {
    const descriptor = makeDescriptor({ fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "shrinemobile", {
      phiApprovedChannels: ["shrinemobile"],
    });
    expect(plan).toEqual({ kind: "text", text: HEALTH_SUMMARY });
  });

  it("(b) non-phiApproved (whatsapp) + health content → MINIMIZED, no health specifics", () => {
    const descriptor = makeDescriptor({ fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "whatsapp", {
      phiApprovedChannels: ["shrinemobile"],
    });
    expect(plan.kind).toBe("text");
    const text = plan.kind === "text" ? plan.text : "";
    // The health-specific summary must NOT appear anywhere in the degraded text.
    expect(text).not.toContain(HEALTH_SUMMARY);
    expect(text).not.toContain("340");
    expect(text).not.toContain("protein");
    expect(text).toBe(MINIMIZED_HEALTH_CONFIRM_TEXT);
  });

  it("(c) non-phiApproved + no health content → ui.summary", () => {
    const descriptor = makeDescriptor({ summary: "Choose a plan", fields: NONE_FIELDS });
    const plan = planChannelRender(descriptor, "whatsapp", {
      phiApprovedChannels: ["shrinemobile"],
    });
    expect(plan).toEqual({ kind: "text", text: "Choose a plan" });
  });

  it("(d) deepLinkBase + pending_id → deep-link appended to the minimized text", () => {
    const descriptor = makeDescriptor({
      fields: HEALTH_FIELDS,
      pending_id: "cnf_abcdefghijklmnopqrstuvwx",
    });
    const plan = planChannelRender(descriptor, "whatsapp", {
      phiApprovedChannels: [],
      deepLinkBase: "https://app.shrine.test/confirm/",
    });
    const text = plan.kind === "text" ? plan.text : "";
    expect(text).toContain("https://app.shrine.test/confirm/cnf_abcdefghijklmnopqrstuvwx");
    expect(text.startsWith(MINIMIZED_HEALTH_CONFIRM_TEXT)).toBe(true);
    // Still no health specifics.
    expect(text).not.toContain(HEALTH_SUMMARY);
    expect(text).not.toContain("340");
  });

  it("(e) default opts (phiApprovedChannels undefined → []) → whatsapp minimizes health content", () => {
    const descriptor = makeDescriptor({ fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT });
  });

  it("does not append a deep-link when pending_id is absent", () => {
    const descriptor = makeDescriptor({ fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "whatsapp", {
      deepLinkBase: "https://app.shrine.test/confirm/",
    });
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT });
  });
});
