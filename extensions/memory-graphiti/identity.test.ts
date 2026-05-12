import { describe, expect, it } from "vitest";
import { deriveChannel, derivePeerId } from "./identity.js";

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
