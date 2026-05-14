/**
 * Session-key parsing tests.
 *
 * Covers the 15 channel-adapter session-key shapes (whatsapp, imessage, line,
 * discord, slack, bluebubbles, matrix, irc, googlechat, feishu, mattermost,
 * lobster, nostr, device-pair, copilot-proxy) without requiring live channel
 * infrastructure. Covers the "comm-channel parsing" objective from the
 * multi-app brainstorm (#36).
 */

import { describe, expect, it } from "vitest";
import { deriveChannel, derivePeerId } from "./session-key.js";

describe("deriveChannel", () => {
  it.each([
    ["agent:s1:whatsapp:direct:+15551234567", "whatsapp"],
    ["agent:s1:imessage:direct:user@example.com", "imessage"],
    ["agent:s1:line:direct:U1234567890", "line"],
    ["agent:s1:discord:guild-123:channel-456", "discord"],
    ["agent:s1:slack:T01:C02:U03", "slack"],
    ["agent:s1:bluebubbles:direct:iMessage;-;+15555550100", "bluebubbles"],
    ["agent:s1:matrix:!room:server.org", "matrix"],
    ["agent:s1:irc:freenode:#channel", "irc"],
    ["agent:s1:googlechat:spaces/AAA:threads/BBB", "googlechat"],
    ["agent:s1:feishu:oc_abc", "feishu"],
    ["agent:s1:mattermost:team:channel", "mattermost"],
    ["agent:s1:lobster:direct:user1", "lobster"],
    ["agent:s1:nostr:direct:npub1abc...", "nostr"],
    ["agent:s1:device-pair:direct:device-abc", "device-pair"],
    ["agent:s1:copilot-proxy:direct:proxy-1", "copilot-proxy"],
  ])("parses %s → channel %s", (key, expected) => {
    expect(deriveChannel(key)).toBe(expected);
  });

  it("returns 'unknown' for malformed keys", () => {
    expect(deriveChannel("")).toBe("unknown");
    expect(deriveChannel("not-an-agent-key")).toBe("unknown");
    expect(deriveChannel("agent:s1")).toBe("unknown");
    expect(deriveChannel("notagent:s1:whatsapp:x")).toBe("unknown");
  });
});

describe("derivePeerId", () => {
  it("extracts peer id after a 'direct' marker", () => {
    expect(derivePeerId("agent:s1:whatsapp:direct:+15551234567")).toBe("+15551234567");
    expect(derivePeerId("agent:s1:imessage:direct:user@example.com")).toBe("user@example.com");
    expect(derivePeerId("agent:s1:line:direct:U1234567890")).toBe("U1234567890");
  });

  it("preserves colon-separated peer segments after 'direct'", () => {
    expect(derivePeerId("agent:s1:matrix:direct:!room:server.org")).toBe("!room:server.org");
    expect(derivePeerId("agent:s1:bluebubbles:direct:iMessage;-;+15555550100")).toBe(
      "iMessage;-;+15555550100",
    );
  });

  it("joins all trailing peer segments when no 'direct' marker", () => {
    // Multi-segment peers (Discord guild:channel, Slack team:channel:user,
    // Google Chat spaces/threads) keep every segment after the channel name —
    // they collectively identify the peer.
    expect(derivePeerId("agent:s1:discord:guild-123:channel-456")).toBe("guild-123:channel-456");
    expect(derivePeerId("agent:s1:slack:T01:C02:U03")).toBe("T01:C02:U03");
    expect(derivePeerId("agent:s1:googlechat:spaces/AAA:threads/BBB")).toBe(
      "spaces/AAA:threads/BBB",
    );
  });

  it("returns the lone trailing segment when only one peer segment exists", () => {
    expect(derivePeerId("agent:s1:feishu:oc_abc")).toBe("oc_abc");
  });

  it("returns the raw key when the prefix isn't 'agent'", () => {
    expect(derivePeerId("not-an-agent-key")).toBe("not-an-agent-key");
    expect(derivePeerId("")).toBe("");
    expect(derivePeerId("agent:only-two-parts")).toBe("agent:only-two-parts");
  });
});
