// Tests for the HTTP chat-path session-key derivation — specifically the L1
// user_scope partitioning added in P1 Phase B (chat-endpoint-contract §5).
//
// The invariants under test:
//   - `deriveUserScopeFromSub` mirrors deriveScopeKey({external_id: sub,id: sub})
//     = sub (trimmed), undefined for an empty/absent sub.
//   - When a user_scope is present it OVERRIDES any client-supplied `user` and
//     ANY `X-OpenClaw-Session-Key`: the session is forced into the user's
//     partition (`<prefix>-user:<scope>`), and the session-key header is threaded
//     only as an L3 conversation suffix WITHIN that partition (never identity).
//   - When no user_scope is present, the legacy path is unchanged.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { derivePeerId } from "../../extensions/shared/session-key.js";
import {
  deriveUserScopeFromSub,
  resolveChannelFromHeader,
  resolveSessionKey,
} from "./http-utils.js";

/** The opaque per-hint segment resolveSessionKey threads for a verified scope. */
function hintSegment(hint: string): string {
  return `h${createHash("sha256").update(hint).digest("hex").slice(0, 16)}`;
}

function reqWith(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("deriveUserScopeFromSub", () => {
  it("returns the trimmed sub when present", () => {
    expect(deriveUserScopeFromSub("user_2abc")).toBe("user_2abc");
    expect(deriveUserScopeFromSub("  user_2abc  ")).toBe("user_2abc");
  });

  it("returns undefined for an empty/whitespace/undefined sub", () => {
    expect(deriveUserScopeFromSub(undefined)).toBeUndefined();
    expect(deriveUserScopeFromSub("")).toBeUndefined();
    expect(deriveUserScopeFromSub("   ")).toBeUndefined();
  });
});

describe("resolveChannelFromHeader — presentation-only x-openclaw-channel", () => {
  it("returns an allowlisted value, normalized (trim + lowercase)", () => {
    expect(resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "webchat" }))).toBe("webchat");
    expect(resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "  WebChat  " }))).toBe(
      "webchat",
    );
  });

  it("returns 'shrinemobile' for the shrinemobile channel (any case)", () => {
    expect(resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "shrinemobile" }))).toBe(
      "shrinemobile",
    );
    expect(resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "SHRINEMOBILE" }))).toBe(
      "shrinemobile",
    );
  });

  it("returns undefined for a non-allowlisted channel (caller defaults to webchat)", () => {
    expect(resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "telegram" }))).toBeUndefined();
  });

  it("returns undefined when the header is absent", () => {
    expect(resolveChannelFromHeader(reqWith())).toBeUndefined();
  });

  it("uses the first value for an array-valued header", () => {
    const req = {
      headers: { "x-openclaw-channel": ["shrinemobile", "telegram"] },
    } as unknown as IncomingMessage;
    expect(resolveChannelFromHeader(req)).toBe("shrinemobile");
  });

  it("respects a custom allowlist", () => {
    expect(
      resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "telegram" }), {
        allowlist: ["telegram"],
      }),
    ).toBe("telegram");
    // default 'webchat' is NOT allowed under a custom allowlist that omits it.
    expect(
      resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "webchat" }), {
        allowlist: ["telegram"],
      }),
    ).toBeUndefined();
  });

  it("never throws on a malformed header value", () => {
    expect(() => resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "" }))).not.toThrow();
    expect(resolveChannelFromHeader(reqWith({ "x-openclaw-channel": "" }))).toBeUndefined();
  });
});

describe("channel header is presentation-only (A&D §S10 invariant)", () => {
  // Two otherwise-identical requests differing ONLY in x-openclaw-channel MUST
  // resolve to the SAME sessionKey and userScope — the channel is not an input
  // to identity/partition derivation, only to messageChannel presentation.
  it("resolveSessionKey is byte-identical regardless of the channel header", () => {
    const base = { "x-openclaw-session-key": "thread-42" };
    const webchat = resolveSessionKey({
      req: reqWith({ ...base, "x-openclaw-channel": "webchat" }),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    const shrinemobile = resolveSessionKey({
      req: reqWith({ ...base, "x-openclaw-channel": "shrinemobile" }),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    expect(webchat).toBe(shrinemobile);
    expect(webchat).toBe(`agent:main:openresponses-user:user_2abc:${hintSegment("thread-42")}`);
  });

  it("deriveUserScopeFromSub does not take the channel header as an input", () => {
    // userScope derives solely from the verified sub; the channel cannot alter it.
    expect(deriveUserScopeFromSub("user_2abc")).toBe(deriveUserScopeFromSub("user_2abc"));
    expect(deriveUserScopeFromSub("user_2abc")).toBe("user_2abc");
  });
});

describe("resolveSessionKey — user_scope partitioning", () => {
  it("forces the session into the user partition when a scope is present", () => {
    const key = resolveSessionKey({
      req: reqWith(),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    // mainKey is lowercased by normalizeMainKey.
    expect(key).toBe("agent:main:openresponses-user:user_2abc");
  });

  it("a client-supplied `user` is IGNORED when a scope is present (identity is the scope)", () => {
    const key = resolveSessionKey({
      req: reqWith(),
      agentId: "main",
      user: "attacker-claimed-identity",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    expect(key).toBe("agent:main:openresponses-user:user_2abc");
    expect(key).not.toContain("attacker-claimed-identity");
  });

  it("an X-OpenClaw-Session-Key is threaded as an opaque hashed L3 suffix INSIDE the user partition, not as identity", () => {
    const key = resolveSessionKey({
      req: reqWith({ "x-openclaw-session-key": "thread-42" }),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    expect(key).toBe(`agent:main:openresponses-user:user_2abc:${hintSegment("thread-42")}`);
    expect(key).not.toContain("thread-42");
  });

  it("two requests with the SAME scope but DIFFERENT session keys share the user partition prefix", () => {
    const a = resolveSessionKey({
      req: reqWith({ "x-openclaw-session-key": "thread-a" }),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    const b = resolveSessionKey({
      req: reqWith({ "x-openclaw-session-key": "thread-b" }),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    expect(a).not.toBe(b);
    expect(a.startsWith("agent:main:openresponses-user:user_2abc")).toBe(true);
    expect(b.startsWith("agent:main:openresponses-user:user_2abc")).toBe(true);
  });

  it("distinct scopes land in distinct partitions (one user → one graph)", () => {
    const a = resolveSessionKey({
      req: reqWith(),
      agentId: "main",
      userScope: "user_a",
      prefix: "openresponses",
    });
    const b = resolveSessionKey({
      req: reqWith(),
      agentId: "main",
      userScope: "user_b",
      prefix: "openresponses",
    });
    expect(a).toBe("agent:main:openresponses-user:user_a");
    expect(b).toBe("agent:main:openresponses-user:user_b");
  });

  it("the openai prefix partitions identically (parity for /v1/chat/completions)", () => {
    const key = resolveSessionKey({
      req: reqWith(),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openai",
    });
    expect(key).toBe("agent:main:openai-user:user_2abc");
  });
});

describe("resolveSessionKey — client session hint cannot steer the derived peer (RED arm)", () => {
  const verified = (hint?: string) =>
    resolveSessionKey({
      req: reqWith(hint === undefined ? {} : { "x-openclaw-session-key": hint }),
      agentId: "main",
      userScope: "user_2caller",
      prefix: "openresponses",
    });

  it("a `direct:<victim>` hint does NOT make derivePeerId return the victim", () => {
    const key = verified("direct:user_2victim");
    expect(derivePeerId(key)).not.toBe("user_2victim");
    expect(derivePeerId(key)).not.toContain("user_2victim");
    expect(derivePeerId(key).startsWith("user_2caller")).toBe(true);
    expect(key).not.toContain("direct");
    expect(key).not.toContain("victim");
  });

  it("structural tokens in the hint (`:`, `main`, `direct`) collapse into ONE opaque segment", () => {
    for (const hint of ["a:b:c", "main", "direct:+15551234567", ":::", "x:direct:y"]) {
      const key = verified(hint);
      const suffix = key.slice("agent:main:openresponses-user:user_2caller:".length);
      expect(suffix).toMatch(/^h[0-9a-f]{16}$/);
      expect(key.split(":")).toHaveLength(5);
    }
  });

  it("the same hint twice yields the identical key (conversation continuity)", () => {
    expect(verified("thread-42")).toBe(verified("thread-42"));
    expect(verified("direct:user_2victim")).toBe(verified("direct:user_2victim"));
  });

  it("different hints yield different keys", () => {
    expect(verified("thread-a")).not.toBe(verified("thread-b"));
  });

  it("no header → unchanged `openresponses-user:<sub>`", () => {
    expect(verified()).toBe("agent:main:openresponses-user:user_2caller");
  });
});

describe("resolveSessionKey — legacy (no scope) path unchanged", () => {
  it("honors an explicit X-OpenClaw-Session-Key verbatim when no scope", () => {
    const key = resolveSessionKey({
      req: reqWith({ "x-openclaw-session-key": "legacy-thread" }),
      agentId: "main",
      prefix: "openresponses",
    });
    expect(key).toBe("legacy-thread");
  });

  it("falls back to a user-keyed main session when a body `user` is present and no scope", () => {
    const key = resolveSessionKey({
      req: reqWith(),
      agentId: "main",
      user: "legacy-user",
      prefix: "openresponses",
    });
    expect(key).toBe("agent:main:openresponses-user:legacy-user");
  });

  it("mints a random session key when neither scope, session-key, nor user is present", () => {
    const a = resolveSessionKey({ req: reqWith(), agentId: "main", prefix: "openresponses" });
    const b = resolveSessionKey({ req: reqWith(), agentId: "main", prefix: "openresponses" });
    expect(a).not.toBe(b); // randomUUID per request
    expect(a.startsWith("agent:main:openresponses:")).toBe(true);
  });
});
