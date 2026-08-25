/**
 * 2c-web — the web descriptor consumer's tolerant-reader contract
 * (channel-tool-hooks A&D §2), asserted against REAL DOM in chromium.
 *
 * The two red-arms named in the A&D before the build:
 *   - stamped + UNKNOWN key ⇒ summary (a valid state, not an error)
 *   - UNSTAMPED confirm-shaped ⇒ NO card (the web renderer must not invent
 *     a card the Governor refused to stamp)
 */

import { html, nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { extractComponentDescriptor, renderComponentCard } from "./component-card.ts";

const STAMPED_CONFIRM = {
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

function message(component: unknown) {
  return { role: "toolResult", content: [], component };
}

function renderToDom(template: unknown): HTMLElement {
  const host = document.createElement("div");
  render(html`${template}`, host);
  return host;
}

function card(component: unknown, opts: Parameters<typeof renderComponentCard>[1] = {}) {
  const descriptor = extractComponentDescriptor(message(component));
  if (!descriptor) {
    return { descriptor: null, host: renderToDom(nothing) };
  }
  return { descriptor, host: renderToDom(renderComponentCard(descriptor, opts)) };
}

describe("2c-web component card — the tolerant-reader contract in DOM", () => {
  it("STAMPED + known key → confirm card: summary, fields, live Confirm/Cancel wired to chat", () => {
    const onSendMessage = vi.fn();
    const { host } = card(STAMPED_CONFIRM, { onSendMessage });

    expect(host.querySelector(".chat-component-card--confirm")).not.toBeNull();
    expect(host.textContent).toContain("Log 2 eggs (156 kcal)?");
    expect(host.textContent).toContain("Food");
    expect(host.textContent).toContain("eggs");

    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    buttons[1].click();
    expect(onSendMessage.mock.calls).toEqual([
      ["Confirm cnf_0123456789abcdefghijkl"],
      ["Cancel cnf_0123456789abcdefghijkl"],
    ]);
  });

  it("RED ARM: UNSTAMPED confirm-shaped → NOTHING (no invented card, no buttons)", () => {
    const unstamped = {
      ...STAMPED_CONFIRM,
      ui: { ...STAMPED_CONFIRM.ui, pending_id: undefined, expires_at: undefined },
    };
    const { host } = card(unstamped);
    expect(host.querySelector(".chat-component-card")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("RED ARM: stamped + UNKNOWN key → summary render (valid state, no buttons)", () => {
    const unknownKey = { ...STAMPED_CONFIRM, key: "future_card_v9" };
    const { host } = card(unknownKey);
    expect(host.querySelector(".chat-component-card--summary")).not.toBeNull();
    expect(host.textContent).toContain("Log 2 eggs (156 kcal)?");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("EXPIRED stamp → summary + expired note, no dead buttons", () => {
    const expired = {
      ...STAMPED_CONFIRM,
      ui: { ...STAMPED_CONFIRM.ui, expires_at: "2020-01-01T00:00:00.000Z" },
    };
    const { host } = card(expired);
    expect(host.textContent).toContain("(expired)");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("UNPARSEABLE expires_at → fail-closed to the expired branch, never live buttons", () => {
    const garbageExpiry = {
      ...STAMPED_CONFIRM,
      ui: { ...STAMPED_CONFIRM.ui, expires_at: "not-a-timestamp" },
    };
    const { host } = card(garbageExpiry);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.textContent).toContain("(expired)");
  });

  it("render: navigate|url → summary fallback for now (degrades loudly, never blank)", () => {
    for (const mode of ["navigate", "url"]) {
      const nav = {
        ...STAMPED_CONFIRM,
        render: mode,
        ui: {
          ...STAMPED_CONFIRM.ui,
          commit_tool: null,
          pending_id: undefined,
          expires_at: undefined,
        },
      };
      const { host } = card(nav);
      expect(host.textContent, mode).toContain("Log 2 eggs (156 kcal)?");
      expect(host.querySelectorAll("button"), mode).toHaveLength(0);
    }
  });

  it("extraction is tolerant: missing summary ⇒ null; junk component ⇒ null", () => {
    expect(extractComponentDescriptor(message({ type: "component", key: "x", ui: {} }))).toBeNull();
    expect(extractComponentDescriptor(message("garbage"))).toBeNull();
    expect(extractComponentDescriptor({ role: "toolResult" })).toBeNull();
  });
});
