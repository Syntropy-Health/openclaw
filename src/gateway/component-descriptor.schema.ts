/**
 * ComponentDescriptor v1 — openclaw's typed adapter (C1 keystone).
 *
 * The client-agnostic tool-result component contract, shared across syntropy
 * (Python/FastMCP producer), openclaw (this gateway), and shrinemobile (Flutter
 * renderer). The canonical schema + shared pact-lite fixtures live in the
 * monorepo at `contracts/component-descriptor/` (v1.schema.json); this module
 * MUST accept every `fixtures/valid/*` and reject every `fixtures/invalid/*`
 * (pinned by component-descriptor.schema.test.ts against vendored copies).
 *
 * Design: workstreams/openclaw-syntropy-agentic-chat/AND.md (C1/D5).
 * Isolated from gateway imports (mirrors open-responses.schema.ts) to enable
 * future codegen and prevent drift.
 *
 * Tolerant-reader rule: unknown fields pass through (additive-only within v1);
 * breaking changes ship as v2.
 */

import { z } from "zod";

/**
 * ≥128-bit CSPRNG id minted by the Confirm Governor — never backend-supplied.
 *
 * SECURITY NOTE: the pattern guarantees id CAPACITY (≥132 bits), not entropy or
 * provenance. A schema-valid pending_id is NOT authorization — the Confirm
 * Governor mints/overwrites pending ids server-side and validates every incoming
 * id against its own single-use store; never trust a descriptor-supplied value.
 */
export const PENDING_ID_PATTERN = /^cnf_[A-Za-z0-9_-]{22,}$/;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep-sanitize a JSON.parse'd value before validation (prototype-pollution
 * guard). JSON.parse creates `__proto__` as an OWN key; zod's looseObject
 * copies unknown keys by assignment, which would turn that key into the parsed
 * object's PROTOTYPE — making unvalidated values (e.g. a fake `pending_id`)
 * readable via normal property access while bypassing every declared check.
 * Rebuilding with plain objects and dropping the unsafe keys closes the class.
 * (Object.entries only visits own enumerable keys, so the rebuild is safe.)
 */
function stripUnsafeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUnsafeKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) {
        continue;
      }
      out[key] = stripUnsafeKeys(entry);
    }
    return out;
  }
  return value;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export const ComponentFieldConstraintsSchema = z.looseObject({
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  maxLength: z.int().min(0).optional(),
  pattern: z.string().optional(),
  /** Allowed values when the field type is "enum". */
  options: z.array(z.union([z.string(), z.number()])).optional(),
  /** Displayed but not editable; an edit attempt is rejected by the Governor. */
  readOnly: z.boolean().optional(),
});

export const ComponentFieldDescriptorSchema = z.looseObject({
  /** Commit-tool argument name this field maps to. */
  name: z.string().regex(KEY_PATTERN),
  type: z.enum(["string", "number", "integer", "boolean", "enum", "photo"]),
  /** Current/previewed value (any JSON type consistent with `type`). */
  value: z.unknown().optional(),
  /** Re-checked server-side by the Governor on user edits (client checks are UX only). */
  constraints: ComponentFieldConstraintsSchema.optional(),
  /** PHI marker: "health" values are minimized on non-phiApproved channels. */
  sensitivity: z.enum(["none", "health"]).optional(),
  label: z.string().optional(),
});

export const ComponentUiSchema = z
  .looseObject({
    /**
     * MANDATORY — the LLM-visible caption + universal degradation text
     * (unknown key / text-only channels). Caption only: confirmation UIs
     * render from `fields`, not `summary`.
     */
    summary: z.string().min(1),
    /** Editable field descriptors; a field not listed here is not editable. */
    fields: z.array(ComponentFieldDescriptorSchema).optional(),
    /** Must be inside the gateway's per-server commitTools allowlist. */
    commit_tool: z.string().nullable().optional(),
    cancel_tool: z.string().nullable().optional(),
    /** Gateway-stamped only (Confirm Governor); single-use. */
    pending_id: z.string().regex(PENDING_ID_PATTERN).optional(),
    /** Gateway-stamped pending expiry; required iff pending_id is present. */
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((ui) => ui.pending_id === undefined || ui.expires_at !== undefined, {
    message: "expires_at is required when pending_id is present",
    path: ["expires_at"],
  });

const ComponentDescriptorBaseSchema = z.looseObject({
  type: z.literal("component"),
  /** Indexes the client component registry. Unknown key ⇒ render `ui.summary`. */
  key: z.string().regex(KEY_PATTERN),
  /**
   * Optional render hint; "navigate"/"url" semantics are owned by the
   * openclaw-channel-tool-hooks A&D (additive-within-v1 vocabulary).
   * Canonical default is "component" — consumers treat absence as "component".
   */
  render: z.enum(["component", "navigate", "url"]).optional(),
  /** Renderer-specific pure data — renderers MUST output-encode. */
  props: z.record(z.string(), z.unknown()),
  ui: ComponentUiSchema,
});

/**
 * openclaw's `ChannelPayloadDescriptor` — the wire shape a plugin tool result
 * carries and the HTTP/channel render paths consume. Input is deep-sanitized
 * (prototype-pollution guard) before validation; always validate through THIS
 * schema (or `parseComponentDescriptor`), not the un-sanitized sub-schemas.
 */
export const ComponentDescriptorSchema = z.preprocess(
  stripUnsafeKeys,
  ComponentDescriptorBaseSchema,
);

export type ComponentFieldConstraints = z.infer<typeof ComponentFieldConstraintsSchema>;
export type ComponentFieldDescriptor = z.infer<typeof ComponentFieldDescriptorSchema>;
export type ComponentUi = z.infer<typeof ComponentUiSchema>;
export type ComponentDescriptor = z.infer<typeof ComponentDescriptorBaseSchema>;

/** A&D (C1/D5) name for the same contract — alias so the doc term resolves in code. */
export const ChannelPayloadDescriptorSchema = ComponentDescriptorSchema;
export type ChannelPayloadDescriptor = ComponentDescriptor;

/** Parse helper: returns the typed descriptor or null (never throws). */
export function parseComponentDescriptor(value: unknown): ComponentDescriptor | null {
  const result = ComponentDescriptorSchema.safeParse(value);
  return result.success ? result.data : null;
}
