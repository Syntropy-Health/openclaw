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

  function navDescriptor(mode: string, url?: unknown) {
    return {
      ...STAMPED_CONFIRM,
      render: mode,
      props: url === undefined ? {} : { url },
      ui: {
        ...STAMPED_CONFIRM.ui,
        commit_tool: null,
        pending_id: undefined,
        expires_at: undefined,
      },
    };
  }

  it("nav-render: https target → anchor card disclosing the HOST, noopener, new tab", () => {
    for (const mode of ["navigate", "url"]) {
      const { host } = card(navDescriptor(mode, "https://journals.example.com/entry/42"));
      const a = host.querySelector("a.chat-component-card__link") as HTMLAnchorElement;
      expect(a, mode).not.toBeNull();
      expect(a.href, mode).toBe("https://journals.example.com/entry/42");
      expect(a.textContent, mode).toContain("journals.example.com");
      expect(a.rel, mode).toContain("noopener");
      expect(a.target, mode).toBe("_blank");
      expect(host.textContent, mode).toContain("Log 2 eggs (156 kcal)?");
    }
  });

  it("nav-render: same-origin relative path → anchor resolved against the page origin", () => {
    const { host } = card(navDescriptor("url", "/sessions/today"));
    const a = host.querySelector("a.chat-component-card__link") as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.href).toBe(new URL("/sessions/today", window.location.origin).href);
  });

  it("RED ARM (phishing rail): javascript:, data:, cross-origin http → summary, NO anchor", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "http://evil.example.com/x",
      "https://", // unparseable even with a base — URL() throws
    ]) {
      const { host } = card(navDescriptor("url", bad));
      expect(host.querySelector("a"), bad).toBeNull();
      expect(host.textContent, bad).toContain("Log 2 eggs (156 kcal)?");
    }
  });

  it("junk that RESOLVES as a same-origin relative path is allowed (it can only link home)", () => {
    // "not a url at all ://" absorbs into the page origin under new URL(x, base)
    // — the resulting anchor targets the user's own gateway, which the origin
    // rule deliberately permits. Pinned so nobody 'fixes' this into a parse
    // strictness that breaks legitimate relative paths.
    const { host } = card(navDescriptor("url", "not a url at all ://"));
    const a = host.querySelector("a.chat-component-card__link") as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(new URL(a.href).origin).toBe(window.location.origin);
  });

  it("nav without a usable target (absent / non-string url) → summary fallback, never blank", () => {
    for (const missing of [undefined, 42, ""]) {
      const { host } = card(navDescriptor("navigate", missing));
      expect(host.querySelector("a"), String(missing)).toBeNull();
      expect(host.textContent, String(missing)).toContain("Log 2 eggs (156 kcal)?");
      expect(host.querySelectorAll("button"), String(missing)).toHaveLength(0);
    }
  });

  it("nav+commit_tool hybrid → SUMMARY with zero affordances + LOGGED reason [CTO-RULING 7403]", () => {
    // Ruling 7403 is the documented authority for this pin's change from
    // nothing→summary: one refusal class, one behavior (the phishing rail
    // already chose loud-degrade), affordances refused, reason logged so a
    // correct refusal never renders identically to a gating regression.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hybrid = { ...navDescriptor("url", "https://ok.example.com/x") };
      (hybrid.ui as Record<string, unknown>).commit_tool = "log_food";
      const { host } = card(hybrid);
      expect(host.textContent).toContain("Log 2 eggs (156 kcal)?");
      expect(host.querySelector("a")).toBeNull();
      expect(host.querySelectorAll("button")).toHaveLength(0);
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("reason=nav_with_commit_tool");
      expect(logged).toContain("food_log_card");
    } finally {
      warn.mockRestore();
    }
  });

  it("the NON-nav unstamped-confirm arm still renders NOTHING (A&D §2, unchanged by 7403)", () => {
    // The ruling governs the nav hybrid only; a plain unstamped confirm card
    // stays refused entirely — its summary alone misreads as a completed
    // action. Pinned so the ruling is not over-applied.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unstamped = {
        ...STAMPED_CONFIRM,
        ui: { ...STAMPED_CONFIRM.ui, pending_id: undefined, expires_at: undefined },
      };
      const { host } = card(unstamped);
      expect(host.querySelector(".chat-component-card")).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("extraction is tolerant: missing summary ⇒ null; junk component ⇒ null", () => {
    expect(extractComponentDescriptor(message({ type: "component", key: "x", ui: {} }))).toBeNull();
    expect(extractComponentDescriptor(message("garbage"))).toBeNull();
    expect(extractComponentDescriptor({ role: "toolResult" })).toBeNull();
  });
});
