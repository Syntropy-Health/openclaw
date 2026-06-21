import { describe, expect, it } from "vitest";
import { formatIdentityContext, formatUnknownUserContext } from "./context.js";
import type { ResolvedIdentity } from "./db.js";

// First unit coverage for persist-user-identity (oc-hygiene #6). Locks the
// [USER_IDENTITY] block downstream plugins (memory-gate, graphiti) parse for the
// canonical user_id / verified flag.

const identity = (over: Partial<ResolvedIdentity> = {}): ResolvedIdentity => ({
  id: "user-1",
  external_id: "ext-1",
  first_name: "Ada",
  last_name: "Lovelace",
  created_at: new Date(0),
  updated_at: new Date(0),
  channel: "whatsapp",
  channel_peer_id: "+15551234567",
  verified: true,
  ...over,
});

describe("formatIdentityContext", () => {
  it("emits the canonical [USER_IDENTITY] block with all fields", () => {
    const block = formatIdentityContext(identity(), "verified");
    expect(block).toBe(
      [
        "[USER_IDENTITY]",
        "user_id: user-1",
        "external_id: ext-1",
        "name: Ada Lovelace",
        "channel: whatsapp",
        "channel_peer_id: +15551234567",
        "verified: true",
        "status: verified",
        "[/USER_IDENTITY]",
      ].join("\n"),
    );
  });

  it("renders null external_id as 'none' and missing names as 'unknown'", () => {
    const block = formatIdentityContext(
      identity({ external_id: null, first_name: null, last_name: null, verified: false }),
      "new_session",
    );
    expect(block).toContain("external_id: none");
    expect(block).toContain("name: unknown");
    expect(block).toContain("verified: false");
    expect(block).toContain("status: new_session");
  });

  it("trims a one-sided name (first only / last only)", () => {
    expect(formatIdentityContext(identity({ last_name: null }), "registered")).toContain(
      "name: Ada",
    );
    expect(formatIdentityContext(identity({ first_name: null }), "registered")).toContain(
      "name: Lovelace",
    );
  });
});

describe("formatUnknownUserContext", () => {
  it("flags an unregistered peer as gate-eligible with the identify/register CTA", () => {
    const block = formatUnknownUserContext("telegram", "peer-9");
    expect(block).toContain("status: unregistered");
    expect(block).toContain("gate_eligible: true");
    expect(block).toContain("channel: telegram");
    expect(block).toContain("channel_peer_id: peer-9");
    expect(block).toContain("!identify <first_name> <last_name>");
    expect(block).toContain("!register <first_name> <last_name>");
    // never leaks a user_id for an unknown peer
    expect(block).toContain("user_id: none");
  });
});
