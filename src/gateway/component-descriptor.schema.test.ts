import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ComponentDescriptorSchema,
  parseComponentDescriptor,
  PENDING_ID_PATTERN,
} from "./component-descriptor.schema.js";

/**
 * Pact-lite contract test: this adapter MUST accept every shared valid fixture
 * and reject every shared invalid fixture. Fixtures are vendored copies of the
 * canonical set at monorepo `contracts/component-descriptor/fixtures/` — keep
 * byte-identical (see __fixtures__/component-descriptor/README.md).
 */
const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "component-descriptor",
);

function loadFixtures(kind: "valid" | "invalid"): Array<{ name: string; data: unknown }> {
  const dir = join(FIXTURES_DIR, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({ name, data: JSON.parse(readFileSync(join(dir, name), "utf8")) }));
}

describe("ComponentDescriptor v1 contract (shared pact-lite fixtures)", () => {
  const valid = loadFixtures("valid");
  const invalid = loadFixtures("invalid");

  it("has fixtures on both sides (vendoring intact)", () => {
    expect(valid.length).toBeGreaterThanOrEqual(4);
    expect(invalid.length).toBeGreaterThanOrEqual(6);
  });

  for (const { name, data } of loadFixtures("valid")) {
    it(`accepts valid/${name}`, () => {
      const result = ComponentDescriptorSchema.safeParse(data);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
        true,
      );
    });
  }

  for (const { name, data } of loadFixtures("invalid")) {
    it(`rejects invalid/${name}`, () => {
      expect(ComponentDescriptorSchema.safeParse(data).success).toBe(false);
    });
  }
});

describe("ComponentDescriptor v1 adapter behavior", () => {
  const minimal = {
    type: "component",
    key: "goto",
    props: { url: "/dashboard" },
    ui: { summary: "Go to dashboard" },
  };

  it("parseComponentDescriptor returns typed data for a minimal descriptor", () => {
    const parsed = parseComponentDescriptor(minimal);
    expect(parsed).not.toBeNull();
    expect(parsed?.key).toBe("goto");
    expect(parsed?.ui.summary).toBe("Go to dashboard");
  });

  it("parseComponentDescriptor returns null (never throws) on junk", () => {
    expect(parseComponentDescriptor(null)).toBeNull();
    expect(parseComponentDescriptor("component")).toBeNull();
    expect(parseComponentDescriptor({ type: "component" })).toBeNull();
  });

  it("is a tolerant reader: unknown fields survive round-trip (additive-within-v1)", () => {
    const parsed = parseComponentDescriptor({
      ...minimal,
      future_field: { keep: true },
      ui: { summary: "Go to dashboard", future_ui_field: 7 },
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error("unreachable");
    }
    expect((parsed as Record<string, unknown>).future_field).toEqual({ keep: true });
    expect((parsed.ui as Record<string, unknown>).future_ui_field).toBe(7);
  });

  it("requires expires_at when pending_id is present (gateway-stamped pair)", () => {
    const withPending = {
      ...minimal,
      ui: {
        summary: "Go",
        pending_id: "cnf_8f3kQ2mN7pXvB4tYw9ZrLa",
      },
    };
    expect(ComponentDescriptorSchema.safeParse(withPending).success).toBe(false);
    expect(
      ComponentDescriptorSchema.safeParse({
        ...minimal,
        ui: {
          summary: "Go",
          pending_id: "cnf_8f3kQ2mN7pXvB4tYw9ZrLa",
          expires_at: "2026-07-09T02:30:00Z",
        },
      }).success,
    ).toBe(true);
  });

  it("pending_id pattern enforces the ≥128-bit gateway-minted shape", () => {
    expect(PENDING_ID_PATTERN.test("cnf_8f3kQ2mN7pXvB4tYw9ZrLa")).toBe(true);
    expect(PENDING_ID_PATTERN.test("cnf_123")).toBe(false);
    expect(PENDING_ID_PATTERN.test("apr_8f3kQ2mN7pXvB4tYw9ZrLa")).toBe(false);
  });

  it("accepts offset datetimes in expires_at (ISO-8601, not just Z)", () => {
    expect(
      ComponentDescriptorSchema.safeParse({
        ...minimal,
        ui: {
          summary: "Go",
          pending_id: "cnf_8f3kQ2mN7pXvB4tYw9ZrLa",
          expires_at: "2026-07-09T02:30:00+02:00",
        },
      }).success,
    ).toBe(true);
  });
});
