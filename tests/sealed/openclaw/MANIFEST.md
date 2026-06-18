# Sealed challenge suite — SYN-206 Task 1 (`formatProfileBlock`)

Spec: `extensions/syntropy/docs/SYN-206-formatProfileBlock.contract.md`
Suite: `profile.sealed.test.ts`

Categories (top-level `describe()` = referee category) → contract section:

| Category | Spec section |
|---|---|
| `functional/formatter` | Return contract — string block; field labels & value rendering (§ "Otherwise returns a string block", field table) |
| `functional/envelope` | Returns `null` cases — failure envelopes, null/undefined/non-object, all-empty profile (§ "Returns `null`") |
| `functional/normalization` | Normalization / robustness — trim/drop array items, drop null object entries, wrong-typed → empty, never throws (§ "Normalization / robustness") |
| `functional/bounds` | Bounds — 200-char value cap + `…` (§ "Bounds") |
| `integration/order` | Field order (SAFETY-CRITICAL) — allergies/conditions precede later fields (§ "Field order") |

No assertion detail is recorded here by design; only category-to-spec mapping.
