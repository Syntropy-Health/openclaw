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

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { deriveUserScopeFromSub, resolveSessionKey } from "./http-utils.js";

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

  it("an X-OpenClaw-Session-Key is threaded as an L3 suffix INSIDE the user partition, not as identity", () => {
    const key = resolveSessionKey({
      req: reqWith({ "x-openclaw-session-key": "thread-42" }),
      agentId: "main",
      userScope: "user_2abc",
      prefix: "openresponses",
    });
    expect(key).toBe("agent:main:openresponses-user:user_2abc:thread-42");
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
