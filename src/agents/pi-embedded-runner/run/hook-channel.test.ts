/**
 * Regression pins for the T1.4.1 §1a defect: the channel the PLUGIN HOOKS see.
 *
 * WHAT BROKE: the hook-ctx builds used the bare `params.messageProvider`. The
 * HTTP chat path populates `messageChannel` ONLY (from `X-OpenClaw-Channel`), so
 * `ctx.messageProvider` was undefined there; the identity hooks fell back to
 * `deriveChannel(sessionKey)` → "openresponses-user", and the [G1] auto-bind
 * guard `AUTO_BIND_CHANNELS.has(channel)` could never match "shrinemobile".
 * A signed-in mobile user got the onboarding verify-CTA and NO binding row was
 * written. Live-verify caught it; no unit test could, because every existing
 * test hand-fed `ctx.messageProvider` — testing the assumption, not the wiring.
 */

import { describe, expect, it } from "vitest";
import { resolveHookChannel } from "./params.js";

describe("resolveHookChannel — the channel plugin hooks observe", () => {
  it("★ HTTP chat path: messageChannel ALONE resolves (the exact broken case)", () => {
    // What /v1/responses actually passes: messageChannel set, messageProvider absent.
    expect(resolveHookChannel({ messageChannel: "shrinemobile" })).toBe("shrinemobile");
  });

  it("channel-originated path: messageProvider alone still resolves (no regression)", () => {
    expect(resolveHookChannel({ messageProvider: "whatsapp" })).toBe("whatsapp");
  });

  it("messageChannel WINS when both are present (matches channelHint + attempt.ts:293)", () => {
    expect(
      resolveHookChannel({ messageChannel: "shrinemobile", messageProvider: "openresponses" }),
    ).toBe("shrinemobile");
  });

  it("neither present → undefined, so callers fall back to deriveChannel(sessionKey)", () => {
    expect(resolveHookChannel({})).toBeUndefined();
  });

  it("★ the auto-bind guard can actually match for a mobile HTTP turn", () => {
    // The end-to-end consequence, stated as an assertion: with only the field the
    // HTTP path sets, the resolved channel must equal the pinned mobile channel
    // that persist-user-identity's AUTO_BIND_CHANNELS gates on.
    const AUTO_BIND_CHANNELS = new Set(["shrinemobile"]);
    const resolved = resolveHookChannel({ messageChannel: "shrinemobile" });
    expect(resolved).toBeDefined();
    expect(AUTO_BIND_CHANNELS.has(resolved as string)).toBe(true);
  });
});
