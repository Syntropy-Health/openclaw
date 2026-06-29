# Sealed challenge suite — Clerk JWKS JWT verifier

Suite: `tests/sealed/clerk-jwt.sealed.test.ts`
Module under test (contract): `src/gateway/clerk-jwt.ts` → `verifyClerkJwt`

This is the only artifact the referee echoes. It maps each category to the
contract clause it challenges. No assertion text or coverage prescriptions live
here — coarse pass/fail-by-category is the only signal that reaches the implementer.

| Category                    | Contract clause exercised                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functional/verify-success` | Valid RS256 token (kid→JWK match, sig verifies, iss/aud/exp/nbf satisfied) resolves to `{ sub, claims }`; `aud` accepted as string or array.                                    |
| `functional/verify-reject`  | Claim/signature failures resolve to `null` (never throw): aud mismatch, iss mismatch, expired, not-yet-valid, missing sub, wrong-key signature, tampered sig, tampered payload. |
| `functional/alg-confusion`  | Header `alg` must be RS256; `HS256` and `none` are rejected (alg-confusion guard).                                                                                              |
| `functional/malformed`      | Structurally invalid tokens (non-three-segment, non-JSON header/payload, empty) resolve to `null`.                                                                              |
| `integration/jwks-fetch`    | Injected `fetchJwks` is consulted; unknown/absent kid → `null`; fetcher invoked on a valid verification.                                                                        |

Determinism: clock fixed via explicit `now`; all keys minted in-process with
`node:crypto`; `fetchJwks` always injected (no network).

Open question for principal (not asserted): contract does not pin the `typ`
header value, nor distinguish missing `aud` from mismatched `aud`. Suite avoids
asserting on either.
