import { describe, expect, it } from "vitest";
import { deriveScopeKey } from "./scope-key.js";

// Canonical contract for the memory partition key shared by auth-memory-gate
// ([MEMORY_SCOPE].scope_key) and memory-graphiti (identity-strategy groupId).
// Pins the user_id-vs-external_id precedence that SJ #9–#11 will revisit.

describe("deriveScopeKey", () => {
  it("prefers external_id (cross-channel) when present", () => {
    expect(deriveScopeKey({ external_id: "ext-123", id: "uuid-1" })).toBe("ext-123");
  });

  it("falls back to the internal user UUID for channel-only users (null external_id)", () => {
    expect(deriveScopeKey({ external_id: null, id: "uuid-1" })).toBe("uuid-1");
  });

  it("accepts a wider identity row (uses only external_id + id)", () => {
    const row = { external_id: "ext-9", id: "uuid-9", first_name: "Ada", verified: true };
    expect(deriveScopeKey(row)).toBe("ext-9");
  });
});
