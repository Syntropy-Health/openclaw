import { describe, expect, it } from "vitest";
import { deriveChannel, derivePeerId, externalIdScopeKey } from "./identity.js";

// ============================================================================
// Session key parsing
// ============================================================================

describe("identity: deriveChannel", () => {
  it("extracts channel from standard session key", () => {
    expect(deriveChannel("agent:main:telegram:user123")).toBe("telegram");
  });

  it("extracts channel from direct session key", () => {
    expect(deriveChannel("agent:main:direct:peer1")).toBe("direct");
  });

  it("returns unknown for non-standard format", () => {
    expect(deriveChannel("unknown-format")).toBe("unknown");
  });

  it("returns unknown for short key", () => {
    expect(deriveChannel("agent:main")).toBe("unknown");
  });
});

describe("identity: derivePeerId", () => {
  it("extracts peerId from channel session key", () => {
    expect(derivePeerId("agent:main:telegram:user123")).toBe("user123");
  });

  it("extracts peerId from direct marker format", () => {
    expect(derivePeerId("agent:main:direct:peer1")).toBe("peer1");
  });

  it("extracts peerId from channel+direct format", () => {
    expect(derivePeerId("agent:main:telegram:direct:peer1")).toBe("peer1");
  });

  it("returns main for shared session", () => {
    expect(derivePeerId("agent:main:main")).toBe("main");
  });

  it("returns full key for non-agent format", () => {
    expect(derivePeerId("some-other-key")).toBe("some-other-key");
  });

  it("handles compound peer IDs with colons", () => {
    expect(derivePeerId("agent:main:whatsapp:+1:234:5678")).toBe("+1:234:5678");
  });
});

// ============================================================================
// externalIdScopeKey — the HTTP/Clerk → group_id preference (#834/#836)
// ============================================================================

describe("identity: externalIdScopeKey", () => {
  it("returns the externalId as the scope key when present (Clerk sub)", () => {
    // The verified Clerk `sub` becomes the group_id directly so an HTTP caller
    // shares the same graph as the same person's lp_users.external_id=sub on
    // WhatsApp — deriveScopeKey({external_id, id}) returns external_id.
    expect(externalIdScopeKey({ externalId: "user_2abc" })).toBe("user_2abc");
  });

  it("returns null when ctx has no externalId (channel caller — unchanged path)", () => {
    expect(externalIdScopeKey({ sessionKey: "agent:main:whatsapp:+15555550001" })).toBeNull();
  });

  it("returns null for null externalId", () => {
    expect(externalIdScopeKey({ externalId: null })).toBeNull();
  });

  it("returns null for empty-string externalId (no fabricated scope key)", () => {
    expect(externalIdScopeKey({ externalId: "" })).toBeNull();
  });

  it("is independent of sessionKey/messageProvider when externalId is present", () => {
    // The DB lookup keys on channel+peer; externalId short-circuits it entirely.
    expect(
      externalIdScopeKey({
        externalId: "user_X",
        sessionKey: "agent:main:webchat:main",
        messageProvider: "webchat",
      }),
    ).toBe("user_X");
  });
});
