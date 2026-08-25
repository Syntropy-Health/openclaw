import { html, nothing, type TemplateResult } from "lit";

/**
 * 2c-web — the web descriptor consumer (channel-tool-hooks A&D §2).
 *
 * Renders C1 ComponentDescriptors lifted onto history messages by the
 * gateway (`chat.history` sanitizer lift). The rules are the SAME
 * tolerant-reader contract the mobile renderer proved (shrinemobile C1):
 *
 *   - unknown `key`            → render `ui.summary` (the v1 guarantee;
 *                                stamped-with-unknown-key is a VALID state)
 *   - stamped + known key      → confirm card with live Confirm/Cancel
 *                                (stamp = `pending_id` + `expires_at`)
 *   - stamped but EXPIRED      → summary with an expired note (no dead
 *                                buttons — the pending is gone server-side)
 *   - confirm-shaped UNSTAMPED → NOTHING (the drop happened upstream and was
 *                                reported there via the #219 discriminator;
 *                                the web renderer must NOT invent a card the
 *                                Governor refused to stamp)
 *   - non-confirm, known key   → summary as an info card
 *   - render: navigate | url   → fallback chain navigate → url → summary
 *                                (increment 3 lands real nav semantics; the
 *                                tolerant fallback ships now so an early nav
 *                                descriptor degrades loudly, never blank)
 *
 * Confirm/Cancel send a structured chat message naming the pending id — the
 * agent invokes the commit tool, and the Governor's pending store + commit
 * guard enforce correctness regardless of what this UI sends. The buttons
 * are UX, not the gate.
 */

/** The keys this web client can render as rich cards (the mobile pattern). */
export const KNOWN_COMPONENT_KEYS: ReadonlySet<string> = new Set(["food_log_card"]);

export type ComponentField = { name?: string; label?: string; value?: unknown };

/** Render a field value for display: primitives verbatim, structures as JSON. */
function formatFieldValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export type WebComponentDescriptor = {
  key: string;
  summary: string;
  props: Record<string, unknown>;
  commitTool: string | null;
  pendingId?: string;
  /** ISO timestamp (the schema's wire type — NOT epoch millis). */
  expiresAt?: string;
  fields: ComponentField[];
  render?: string;
};

/**
 * Tolerant extraction of the lifted `component` field on a history message.
 * Returns null for anything that does not carry the minimum contract —
 * `ui.summary` is the one field every render path needs (the v1 guarantee).
 */
export function extractComponentDescriptor(message: unknown): WebComponentDescriptor | null {
  const m = message as Record<string, unknown> | null | undefined;
  const component = m?.component;
  if (!component || typeof component !== "object") {
    return null;
  }
  const c = component as Record<string, unknown>;
  const ui = c.ui;
  if (!ui || typeof ui !== "object") {
    return null;
  }
  const u = ui as Record<string, unknown>;
  const summary = typeof u.summary === "string" ? u.summary.trim() : "";
  if (!summary) {
    return null;
  }
  const rawFields = Array.isArray(u.fields) ? u.fields : [];
  const props = c.props && typeof c.props === "object" ? (c.props as Record<string, unknown>) : {};
  return {
    key: typeof c.key === "string" ? c.key : "",
    summary,
    props,
    commitTool: typeof u.commit_tool === "string" ? u.commit_tool : null,
    pendingId: typeof u.pending_id === "string" ? u.pending_id : undefined,
    expiresAt: typeof u.expires_at === "string" ? u.expires_at : undefined,
    fields: rawFields.filter((f): f is ComponentField => Boolean(f) && typeof f === "object"),
    render: typeof c.render === "string" ? c.render : undefined,
  };
}

/**
 * The nav target contract (proposed cross-consumer, tests-as-authority):
 * `props.url` carries the destination. Accepted: absolute https:, or a
 * same-origin target (relative paths resolve against the page origin).
 * Everything else — http: cross-origin, javascript:, data:, unparseable —
 * resolves to null and the card degrades to summary with NO anchor.
 */
export function resolveNavTarget(
  descriptor: WebComponentDescriptor,
): { href: string; host: string } | null {
  const raw = descriptor.props.url;
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  const sameOrigin = parsed.origin === window.location.origin;
  if (parsed.protocol !== "https:" && !sameOrigin) {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    // javascript:, data:, blob: … can never be a nav target, even "same-origin".
    return null;
  }
  return { href: parsed.href, host: parsed.host };
}

export function renderComponentCard(
  descriptor: WebComponentDescriptor,
  opts: { onSendMessage?: (text: string) => void; now?: number } = {},
): TemplateResult | typeof nothing {
  const now = opts.now ?? Date.now();
  const stamped = Boolean(descriptor.pendingId) && typeof descriptor.expiresAt === "string";
  const confirmShaped = Boolean(descriptor.commitTool);
  const navMode = descriptor.render === "navigate" || descriptor.render === "url";

  // STRICTER ARM, per [CTO-RULING dispatch 7403]: a nav descriptor that ALSO
  // carries a commit_tool refuses its AFFORDANCES (no anchor, no buttons) but
  // renders the SUMMARY — one refusal class, one behavior: the phishing rail
  // already chose loud-degrade over blank, and blank is indistinguishable
  // from a broken client. The refusal reason is LOGGED at the refusal point
  // so a correct refusal and a gating regression never render identically
  // (the discriminator exists upstream of the collapse). Mobile renders the
  // same summary; this line is the web client's half of that convergence.
  if (navMode && confirmShaped) {
    console.warn(
      `component-card: nav descriptor REFUSED affordances reason=nav_with_commit_tool key=${JSON.stringify(descriptor.key)} — summary rendered, no anchor/buttons`,
    );
    return html`<div class="chat-component-card chat-component-card--summary">
      ${descriptor.summary}
    </div>`;
  }

  // Confirm-shaped but unstamped (NON-nav): the Governor refused (or never
  // saw) this descriptor — the drop is reported upstream. Rendering it here
  // would give an ungated card the visual authority of a gated one. This arm
  // stays NOTHING per A&D §2 (the shrinemobile-aligned contract): a confirm
  // card is affordance-first, and its summary alone misreads as a completed
  // action. Distinct from the nav hybrid above, which ruling 7403 governs.
  if (confirmShaped && !stamped) {
    return nothing;
  }

  // NAV MODES (increment 3, A&D §3): the web client has no SJ-surface route
  // registry, so `navigate` takes the DECLARED fallback chain — url rendering
  // when a target exists, summary otherwise. `url` renders an anchor card.
  // The phishing rail is enforced here: the target must pass
  // resolveNavTarget's scheme/origin rules or NO anchor renders (summary
  // degrade — loud, never a live link to an unvetted destination), and the
  // anchor DISCLOSES its host so the user sees where they are going. Lit
  // interpolation output-encodes; nothing here touches unsafeHTML.
  if (navMode) {
    const target = resolveNavTarget(descriptor);
    if (!target) {
      return html`<div class="chat-component-card chat-component-card--summary">
        ${descriptor.summary}
      </div>`;
    }
    return html`<div class="chat-component-card chat-component-card--nav">
      <div class="chat-component-card__summary">${descriptor.summary}</div>
      <a
        class="chat-component-card__link"
        href=${target.href}
        target="_blank"
        rel="noopener noreferrer"
        >Open ${target.host}</a
      >
    </div>`;
  }

  // Unknown key: the summary IS the degraded render, and it names what
  // happened rather than going blank.
  const richKey = KNOWN_COMPONENT_KEYS.has(descriptor.key);
  if (!richKey) {
    return html`<div class="chat-component-card chat-component-card--summary">
      ${descriptor.summary}
    </div>`;
  }

  // Fail-closed on the expiry read: an unparseable expires_at must NOT show
  // live confirm buttons — NaN comparisons are engineered to land in the
  // expired branch, never the live one.
  const expiresAtMs = stamped ? Date.parse(descriptor.expiresAt as string) : Number.NaN;
  const live = stamped && Number.isFinite(expiresAtMs) && expiresAtMs > now;
  const expired = stamped && !live;
  if (live) {
    const pendingId = descriptor.pendingId as string;
    const confirm = () => opts.onSendMessage?.(`Confirm ${pendingId}`);
    const cancel = () => opts.onSendMessage?.(`Cancel ${pendingId}`);
    return html`<div class="chat-component-card chat-component-card--confirm">
      <div class="chat-component-card__summary">${descriptor.summary}</div>
      ${
        descriptor.fields.length > 0
          ? html`<dl class="chat-component-card__fields">
              ${descriptor.fields.map(
                (f) =>
                  html`<div class="chat-component-card__field">
                    <dt>${f.label ?? f.name ?? ""}</dt>
                    <dd>${formatFieldValue(f.value)}</dd>
                  </div>`,
              )}
            </dl>`
          : nothing
      }
      <div class="chat-component-card__actions">
        <button class="btn btn--primary" @click=${confirm}>Confirm</button>
        <button class="btn" @click=${cancel}>Cancel</button>
      </div>
    </div>`;
  }

  if (expired) {
    return html`<div class="chat-component-card chat-component-card--summary">
      ${descriptor.summary}
      <span class="muted"> (expired)</span>
    </div>`;
  }

  // Non-confirm informational card with a known key.
  return html`<div class="chat-component-card chat-component-card--summary">
    ${descriptor.summary}
  </div>`;
}
