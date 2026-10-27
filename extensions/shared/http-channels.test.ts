import { describe, expect, it } from "vitest";
import { isHttpShapedSession } from "./http-channels.js";

describe("isHttpShapedSession", () => {
  it("is true for an HTTP gate channel, whatever the session key", () => {
    expect(isHttpShapedSession("shrinemobile", "agent:main:telegram:direct:x")).toBe(true);
    expect(isHttpShapedSession("webchat", "")).toBe(true);
  });

  it("is true for a gateway HTTP session key reported without an HTTP channel", () => {
    expect(isHttpShapedSession(undefined, "agent:main:openresponses-user:direct:dev-B")).toBe(true);
    expect(isHttpShapedSession("openai-user", "agent:main:openai-user:u1")).toBe(true);
    expect(isHttpShapedSession(null, "agent:main:openai-user:u1")).toBe(true);
  });

  it("a raw webchat session key is HTTP-shaped", () => {
    expect(isHttpShapedSession(undefined, "agent:main:webchat:direct:user_2B")).toBe(true);
  });

  it("is false for channel turns", () => {
    expect(isHttpShapedSession("whatsapp", "agent:main:whatsapp:direct:+15550001111")).toBe(false);
    expect(isHttpShapedSession(undefined, "agent:main:telegram:direct:u")).toBe(false);
    expect(isHttpShapedSession(undefined, "agent:main:main")).toBe(false);
  });
});
