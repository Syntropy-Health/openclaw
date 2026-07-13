import { describe, expect, it } from "vitest";
import { CHAT_CHANNEL_ORDER } from "../../channels/registry.js";
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

  it("NAV-BYPASS CLOSED: render:navigate card on whatsapp → MINIMIZED (no producer-controlled full-summary path)", () => {
    // render is producer-controlled: a mismarked/compromised backend could tag a
    // health card render:navigate to smuggle the summary. The ONLY full-summary
    // path is an explicitly-phiApproved channel — never a descriptor field.
    const descriptor = makeDescriptor({ render: "navigate", summary: "Go to your dashboard" });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
  });

  it("NAV-BYPASS CLOSED: render:url card on whatsapp → MINIMIZED", () => {
    const descriptor = makeDescriptor({ render: "url", summary: "Open the link" });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
  });

  it("NAV-BYPASS CLOSED: a render:navigate descriptor with a HEALTH summary + health field on whatsapp → MINIMIZED (the smuggling vector)", () => {
    const descriptor = makeDescriptor({
      render: "navigate",
      summary: HEALTH_SUMMARY,
      fields: HEALTH_FIELDS,
    });
    const plan = planChannelRender(descriptor, "whatsapp");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
    if (plan.kind === "text") {
      assertNoHealthLeak(plan.text);
    }
  });

  it("NAV-BYPASS CLOSED: render:navigate on an UNKNOWN channel → MINIMIZED", () => {
    const descriptor = makeDescriptor({ render: "navigate", summary: "Go to your dashboard" });
    const plan = planChannelRender(descriptor, "some_future_channel");
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
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
  it("normalizes case + whitespace so a mixed-case/padded denylisted entry is still stripped", () => {
    expect(isThirdPartyChannel("WhatsApp")).toBe(true);
    expect(isThirdPartyChannel(" whatsapp ")).toBe(true);
    const { approved, ignored } = sanitizePhiApprovedChannels([
      "WhatsApp",
      " Slack ",
      "shrinemobile",
    ]);
    expect(approved).toEqual(["shrinemobile"]);
    expect(ignored).toEqual(["WhatsApp", " Slack "]);
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

  it("NAV-BYPASS CLOSED: nav component on whatsapp → scrub MINIMIZED (not full summary)", () => {
    const carrier = componentCarrier(
      makeDescriptor({ render: "navigate", summary: "Go to your dashboard" }),
    );
    expect(planChannelDataRender(carrier, "whatsapp")).toEqual({
      action: "scrub",
      text: MINIMIZED_HEALTH_CONFIRM_TEXT,
      minimized: true,
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-IRC (CTO #3578): deny-unknown PHI posture. The denylist was NOT complete
// (`irc` omitted) → an operator could phiApprove `irc` and leak PHI. The fix
// hardens the SHAPE: a channel is third-party (PHI-denied) UNLESS explicitly
// first-party, so `irc` AND any unknown/future channel is refused at RUNTIME,
// not merely caught by a lint. These assert the behavioral guarantee.
// ---------------------------------------------------------------------------
describe("SEC-IRC: deny-unknown PHI posture (CTO #3578)", () => {
  it("irc is third-party (the omitted-denylist fail-open is closed)", () => {
    expect(isThirdPartyChannel("irc")).toBe(true);
    expect(KNOWN_THIRD_PARTY_CHANNELS).toContain("irc");
  });

  it("BEHAVIORAL: a phiApproved-irc config is REFUSED at policy level → minimized (not full summary)", () => {
    const descriptor = makeDescriptor({ render: "component", fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "irc", { phiApprovedChannels: ["irc"] });
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
    if (plan.kind === "text") {
      assertNoHealthLeak(plan.text);
    }
  });

  it("deny-unknown: an unknown/future channel can NEVER be phiApproved via config (runtime, not lint)", () => {
    expect(isThirdPartyChannel("some_unknown_channel_xyz")).toBe(true);
    const descriptor = makeDescriptor({ render: "component", fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "some_unknown_channel_xyz", {
      phiApprovedChannels: ["some_unknown_channel_xyz"],
    });
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
  });

  it("COMPLETENESS: every core registry channel (CHAT_CHANNEL_ORDER) is third-party (no omission possible)", () => {
    for (const channel of CHAT_CHANNEL_ORDER) {
      expect(
        isThirdPartyChannel(channel),
        `registry channel '${channel}' must be third-party`,
      ).toBe(true);
    }
  });

  it("REGRESSION: the app's own surfaces (shrinemobile/webchat) stay approvable", () => {
    for (const channel of ["shrinemobile", "webchat"]) {
      expect(isThirdPartyChannel(channel), `${channel} must stay first-party`).toBe(false);
    }
    const { approved, ignored } = sanitizePhiApprovedChannels(["irc", "shrinemobile"]);
    expect(approved).toEqual(["shrinemobile"]);
    expect(ignored).toEqual(["irc"]);
  });

  it("MATRIX DEMOTED (CTO #3581): matrix is third-party (federated protocol = counsel-gate class)", () => {
    // Matrix is a federated messaging provider — squarely the SEC-4 counsel-gate
    // class ("third-party messaging providers can NEVER be phiApproved"). Demoted
    // from the first-party allowlist. A federation-disabled self-hosted homeserver
    // may re-argue first-party later WITH deployment evidence.
    expect(isThirdPartyChannel("matrix")).toBe(true);
    // Behavioral: a phiApproved-matrix config is now REFUSED → minimized.
    const descriptor = makeDescriptor({ render: "component", fields: HEALTH_FIELDS });
    const plan = planChannelRender(descriptor, "matrix", { phiApprovedChannels: ["matrix"] });
    expect(plan).toEqual({ kind: "text", text: MINIMIZED_HEALTH_CONFIRM_TEXT, minimized: true });
    if (plan.kind === "text") {
      assertNoHealthLeak(plan.text);
    }
  });
});
