import { describe, expect, it, vi } from "vitest";
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  deliverViaCapabilities,
  type DeliveryPayload,
} from "./channel-adapter.js";

// ---------------------------------------------------------------------------
// SEALED challenge suite — Phase 0, Task 0.1 (C0 ChannelAdapter contract).
// Authored from the FROZEN interface contract ONLY; no implementation was read.
//
// Core invariant under challenge: the CAPABILITY-FALLBACK resolver + the `via`
// observable (the atomicity seam). A build MUST NOT silently drop an
// undeliverable link, and MUST NOT deliver inline when the channel can't render
// it inline. Every routing decision is asserted through `via` AND through which
// sink was (and was NOT) called.
// ---------------------------------------------------------------------------

const COMPANION_E164 = "+15551230001";

/** Records which sink fired and with what args; each sink resolves true (delivered). */
function makeSinks() {
  const inline = vi.fn(async (_p: DeliveryPayload): Promise<boolean> => true);
  const companion = vi.fn(async (_toE164: string, _p: DeliveryPayload): Promise<boolean> => true);
  return { inline, companion };
}

function caps(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    inline_link: false,
    inline_text: false,
    phi_approved: false,
    ...overrides,
  };
}

const linkPayload: DeliveryPayload = { kind: "link", url: "https://sj.local/verify?t=abc" };
const otpPayload: DeliveryPayload = { kind: "otp", code: "123456" };
const textPayload: DeliveryPayload = { kind: "text", text: "hello" };

// ---------------------------------------------------------------------------
// 1. FALLBACK — inline_link=false + companion set → routes to the COMPANION sink.
// ---------------------------------------------------------------------------

describe("deliverViaCapabilities — companion fallback (inline_link=false)", () => {
  it.each([
    ["link", linkPayload],
    ["otp", otpPayload],
  ])("routes a %s payload to companion when inline_link=false + companion set", async (_k, p) => {
    const sinks = makeSinks();
    const result = await deliverViaCapabilities(
      caps({ inline_link: false, companion_text_channel: COMPANION_E164 }),
      p as DeliveryPayload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "companion" });
    expect(sinks.companion).toHaveBeenCalledTimes(1);
    expect(sinks.companion).toHaveBeenCalledWith(COMPANION_E164, p);
    expect(sinks.inline).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. INLINE — inline_link=true → routes INLINE (companion untouched).
// ---------------------------------------------------------------------------

describe("deliverViaCapabilities — inline delivery (inline_link=true)", () => {
  it("routes a link payload inline; companion sink is never called", async () => {
    const sinks = makeSinks();
    const result = await deliverViaCapabilities(
      // companion is set too, but inline capability wins for links.
      caps({ inline_link: true, companion_text_channel: COMPANION_E164 }),
      linkPayload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "inline" });
    expect(sinks.inline).toHaveBeenCalledTimes(1);
    expect(sinks.inline).toHaveBeenCalledWith(linkPayload);
    expect(sinks.companion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. TEXT payloads follow inline_text (independently of inline_link).
// ---------------------------------------------------------------------------

describe("deliverViaCapabilities — text payloads follow inline_text", () => {
  it("inline_text=false + companion set → companion", async () => {
    const sinks = makeSinks();
    const result = await deliverViaCapabilities(
      caps({ inline_text: false, companion_text_channel: COMPANION_E164 }),
      textPayload,
      sinks,
    );
    expect(result).toEqual({ ok: true, via: "companion" });
    expect(sinks.companion).toHaveBeenCalledWith(COMPANION_E164, textPayload);
    expect(sinks.inline).not.toHaveBeenCalled();
  });

  it("inline_text=true → inline", async () => {
    const sinks = makeSinks();
    const result = await deliverViaCapabilities(
      caps({ inline_text: true, companion_text_channel: COMPANION_E164 }),
      textPayload,
      sinks,
    );
    expect(result).toEqual({ ok: true, via: "inline" });
    expect(sinks.inline).toHaveBeenCalledWith(textPayload);
    expect(sinks.companion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. FAIL-CLOSED — inline_link=false AND no companion → {ok:false}, never drop.
// ---------------------------------------------------------------------------

describe("deliverViaCapabilities — fail-closed with no delivery path", () => {
  it("returns {ok:false} for a link when inline_link=false and no companion (no silent drop, no throw)", async () => {
    const sinks = makeSinks();
    const result = await deliverViaCapabilities(
      caps({ inline_link: false, companion_text_channel: undefined }),
      linkPayload,
      sinks,
    );
    // MUST resolve (not reject) with ok:false — cannot deliver.
    expect(result.ok).toBe(false);
    // And it must NOT have quietly shoved the link out an inline path it can't render.
    expect(sinks.inline).not.toHaveBeenCalled();
    expect(sinks.companion).not.toHaveBeenCalled();
  });

  it("does not throw when there is no deliverable path", async () => {
    const sinks = makeSinks();
    await expect(
      deliverViaCapabilities(caps({ inline_link: false }), otpPayload, sinks),
    ).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. End-to-end via a FakeAdapter implementing the ChannelAdapter interface.
// ---------------------------------------------------------------------------

type Delivered = { via: "inline" | "companion"; payload: DeliveryPayload; toE164?: string };

/**
 * A minimal in-test adapter that wires its deliver() through the SHARED resolver,
 * exactly as a real adapter is expected to. `voice`-like: inline_link=false +
 * companion set. `sms`-like: inline everything.
 */
class FakeAdapter implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities;
  readonly deliveries: Delivered[] = [];
  private readonly channelId: string;

  constructor(channelId: string, capabilities: ChannelCapabilities) {
    this.channelId = channelId;
    this.capabilities = capabilities;
  }

  identity(inbound: unknown): { e164: string; channelId: string } {
    // Normalize a native id (e.g. "tel:5551230009" or a bare number) to E.164.
    const raw = String((inbound as { from?: unknown })?.from ?? inbound ?? "");
    const digits = raw.replace(/[^0-9]/g, "");
    return { e164: `+${digits}`, channelId: this.channelId };
  }

  deliver(payload: DeliveryPayload): Promise<{ ok: boolean; via: "inline" | "companion" }> {
    return deliverViaCapabilities(this.capabilities, payload, {
      inline: async (p) => {
        this.deliveries.push({ via: "inline", payload: p });
        return true;
      },
      companion: async (toE164, p) => {
        this.deliveries.push({ via: "companion", payload: p, toE164 });
        return true;
      },
    });
  }
}

describe("ChannelAdapter end-to-end (FakeAdapter)", () => {
  it("a voice-like adapter delivers a link via the companion channel", async () => {
    const voice = new FakeAdapter(
      "voice",
      caps({ inline_link: false, inline_text: false, companion_text_channel: COMPANION_E164 }),
    );
    const res = await voice.deliver(linkPayload);
    expect(res).toEqual({ ok: true, via: "companion" });
    expect(voice.deliveries).toEqual([
      { via: "companion", payload: linkPayload, toE164: COMPANION_E164 },
    ]);
  });

  it("an sms-like adapter delivers a link inline", async () => {
    const sms = new FakeAdapter("sms", caps({ inline_link: true, inline_text: true }));
    const res = await sms.deliver(linkPayload);
    expect(res).toEqual({ ok: true, via: "inline" });
    expect(sms.deliveries).toEqual([{ via: "inline", payload: linkPayload }]);
  });

  it("identity() normalizes a native id to an {e164, channelId} shape (E.164)", async () => {
    const sms = new FakeAdapter("sms", caps({ inline_link: true, inline_text: true }));
    const id = sms.identity({ from: "tel:+1 (555) 123-0009" });
    expect(id).toMatchObject({ channelId: "sms" });
    expect(typeof id.e164).toBe("string");
    expect(id.e164.startsWith("+")).toBe(true);
  });
});
