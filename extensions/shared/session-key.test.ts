import { describe, expect, it } from "vitest";
import { deriveChannel, derivePeerId } from "./session-key.js";

// Canonical contract for the session-key parser shared by persist-user-identity,
// auth-memory-gate, and syntropy (oc-hygiene #7). The per-extension suites
// (syntropy/session-key.test.ts, auth-memory-gate/scope.test.ts) assert the
// re-exports resolve here; this suite pins the convention itself.

describe("deriveChannel (shared)", () => {
  it.each([
    ["agent:abc:whatsapp:direct:+15551234567", "whatsapp"],
    ["agent:abc:imessage:direct:user@example.com", "imessage"],
    ["agent:abc:discord:guild-123:channel-456", "discord"],
    ["agent:abc:slack:T01:C02:U03", "slack"],
    ["agent:main:telegram:user123", "telegram"],
    ["agent:main:direct:peer1", "direct"],
  ])("%s → %s", (key, expected) => {
    expect(deriveChannel(key)).toBe(expected);
  });

  it("returns 'unknown' for non-agent / too-short keys", () => {
    expect(deriveChannel("")).toBe("unknown");
    expect(deriveChannel("not-an-agent-key")).toBe("unknown");
    expect(deriveChannel("agent:main")).toBe("unknown");
  });
});

describe("derivePeerId (shared)", () => {
  it.each([
    ["agent:abc:whatsapp:direct:+15551234567", "+15551234567"],
    ["agent:main:telegram:user123", "user123"],
    ["agent:main:direct:peer1", "peer1"],
    ["agent:main:telegram:direct:peer1", "peer1"],
    // multi-colon peer ids (e.g. slack T:C:U, phone +1:234:5678) are preserved
    ["agent:main:whatsapp:+1:234:5678", "+1:234:5678"],
    ["agent:abc:slack:T01:C02:U03", "T01:C02:U03"],
  ])("%s → %s", (key, expected) => {
    expect(derivePeerId(key)).toBe(expected);
  });

  it("returns 'main' for the shared (no-peer) session and echoes non-agent keys", () => {
    expect(derivePeerId("agent:main:main")).toBe("main");
    expect(derivePeerId("some-other-key")).toBe("some-other-key");
  });
});
