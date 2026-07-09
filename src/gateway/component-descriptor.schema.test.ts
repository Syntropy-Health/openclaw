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

/**
 * Manifest of the canonical fixture set — a dropped/renamed vendored fixture
 * fails loudly here (vendoring-drift backstop beyond the raw count guard).
 */
const EXPECTED_VALID_FIXTURES = [
  "food_log_card_preview.json",
  "goto_navigate.json",
  "paywall_card_minimal.json",
  "unknown_future_fields_tolerated.json",
];
const EXPECTED_INVALID_FIXTURES = [
  "bad_field_descriptor.json",
  "bad_key_format.json",
  "missing_summary.json",
  "pending_without_expiry.json",
  "weak_pending_id.json",
  "wrong_type_discriminator.json",
];

describe("ComponentDescriptor v1 contract (shared pact-lite fixtures)", () => {
  const valid = loadFixtures("valid");
  const invalid = loadFixtures("invalid");

  it("vendored fixture set matches the canonical manifest (drift backstop)", () => {
    expect(valid.map((f) => f.name).toSorted()).toEqual(EXPECTED_VALID_FIXTURES.toSorted());
    expect(invalid.map((f) => f.name).toSorted()).toEqual(EXPECTED_INVALID_FIXTURES.toSorted());
  });

  for (const { name, data } of valid) {
    it(`accepts valid/${name}`, () => {
      const result = ComponentDescriptorSchema.safeParse(data);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
        true,
      );
    });
  }

  for (const { name, data } of invalid) {
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

  it("SEC-1: __proto__ smuggling cannot plant unvalidated ui values (prototype-pollution guard)", () => {
    // JSON.parse creates __proto__ as an OWN key; a naive object copy (assignment)
    // turns it into the parsed object's prototype, making unvalidated values
    // readable via normal property access. The schema must strip such keys.
    const payload = JSON.parse(
      `{"type":"component","key":"goto","props":{},` +
        `"ui":{"summary":"x","__proto__":{"pending_id":"cnf_SHORT","expires_at":"junk"}}}`,
    );
    const parsed = parseComponentDescriptor(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.ui.pending_id).toBeUndefined();
    expect(parsed?.ui.expires_at).toBeUndefined();
  });

  it("SEC-1: __proto__ smuggling cannot flip constraints.readOnly on a field", () => {
    const payload = JSON.parse(
      `{"type":"component","key":"goto","props":{},` +
        `"ui":{"summary":"x","fields":[{"name":"quantity","type":"number",` +
        `"constraints":{"__proto__":{"readOnly":true}}}]}}`,
    );
    const parsed = parseComponentDescriptor(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.ui.fields?.[0]?.constraints?.readOnly).toBeUndefined();
  });

  it("SEC-1: constructor/prototype keys are also stripped at every depth", () => {
    const payload = JSON.parse(
      `{"type":"component","key":"goto","props":{"constructor":{"x":1}},` +
        `"ui":{"summary":"x","prototype":{"y":2}}}`,
    );
    const parsed = parseComponentDescriptor(payload);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed?.props ?? {})).not.toContain("constructor");
    expect(Object.keys((parsed?.ui ?? {}) as Record<string, unknown>)).not.toContain("prototype");
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

describe("ComponentDescriptor v1 coverage locks (QG findings TEST-1..7)", () => {
  const base = {
    type: "component",
    key: "goto",
    props: { url: "/dashboard" },
    ui: { summary: "Go to dashboard" },
  };
  const ok = (value: unknown) => ComponentDescriptorSchema.safeParse(value).success;

  it("TEST-1: props must be an object — arrays/strings/numbers/null/absent all reject", () => {
    for (const props of [[], [1, 2], "string", 5, null]) {
      expect(ok({ ...base, props }), `props=${JSON.stringify(props)}`).toBe(false);
    }
    const { props: _omitted, ...noProps } = base;
    expect(ok(noProps)).toBe(false);
    expect(ok({ ...base, props: {} })).toBe(true);
  });

  it("TEST-2: malformed expires_at rejects (garbage, date-only, impossible datetime)", () => {
    for (const expires_at of ["not-a-date", "2026-07-09", "2026-13-40T99:99:99Z"]) {
      const value = {
        ...base,
        ui: { summary: "Go", pending_id: "cnf_8f3kQ2mN7pXvB4tYw9ZrLa", expires_at },
      };
      expect(ok(value), `expires_at=${expires_at}`).toBe(false);
    }
  });

  it("TEST-3: expires_at WITHOUT pending_id is VALID (dependency is one-directional)", () => {
    expect(ok({ ...base, ui: { summary: "Go", expires_at: "2026-07-09T02:30:00Z" } })).toBe(true);
  });

  it("TEST-4: key pattern per-violation-class table (+ field name pattern negatives)", () => {
    for (const key of ["Goto", "9goto", "", "go-to", "go to"]) {
      expect(ok({ ...base, key }), `key=${JSON.stringify(key)}`).toBe(false);
    }
    expect(ok({ ...base, key: "go_to2" })).toBe(true);
    const withFieldName = (name: string) => ({
      ...base,
      ui: { summary: "Go", fields: [{ name, type: "string" }] },
    });
    for (const name of ["Quantity", "9q", "", "q-1"]) {
      expect(ok(withFieldName(name)), `field name=${JSON.stringify(name)}`).toBe(false);
    }
    expect(ok(withFieldName("q_1"))).toBe(true);
  });

  it("TEST-5: empty-string summary rejects (minLength 1)", () => {
    expect(ok({ ...base, ui: { summary: "" } })).toBe(false);
  });

  it("TEST-6: enum vocabularies locked (positive + negative per enum)", () => {
    expect(ok({ ...base, render: "url" })).toBe(true);
    expect(ok({ ...base, render: "modal" })).toBe(false);
    const withFieldType = (type: string) => ({
      ...base,
      ui: { summary: "Go", fields: [{ name: "flag", type }] },
    });
    expect(ok(withFieldType("boolean"))).toBe(true);
    expect(ok(withFieldType("date"))).toBe(false);
    const withSensitivity = (sensitivity: string) => ({
      ...base,
      ui: { summary: "Go", fields: [{ name: "flag", type: "boolean", sensitivity }] },
    });
    expect(ok(withSensitivity("none"))).toBe(true);
    expect(ok(withSensitivity("phi"))).toBe(false);
  });

  it("TEST-7: constraints.readOnly/pattern and commit_tool:null positive paths", () => {
    expect(
      ok({
        ...base,
        ui: {
          summary: "Go",
          commit_tool: null,
          fields: [
            { name: "code", type: "string", constraints: { readOnly: true, pattern: "^x" } },
          ],
        },
      }),
    ).toBe(true);
  });
});
