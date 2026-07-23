---
receipt_version: 1
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: openclaw
workstream: shrinemobile-live-gateway
project: SyntropyHealth-Applications
diff_base: d6cddd7274f8e9b816b9b3b56717abd0b90541f8
hash_a: cb616e22c35aa7626bd99643c1ba3d9dca57b7a2930114f64417b836b4ff4dce
hash_b: cb616e22c35aa7626bd99643c1ba3d9dca57b7a2930114f64417b836b4ff4dce
hash_c: cb616e22c35aa7626bd99643c1ba3d9dca57b7a2930114f64417b836b4ff4dce
hash_d: cb616e22c35aa7626bd99643c1ba3d9dca57b7a2930114f64417b836b4ff4dce
hash_d_source: "CI-hygiene fixes (CTO CI-triage routing #4484); no principal 1B1 — infra fixes, not a feature"
hash_e: cb616e22c35aa7626bd99643c1ba3d9dca57b7a2930114f64417b836b4ff4dce
date: 2026-07-22T23:51
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): cb616e2 — artifact entering the gate
- E (final): cb616e2 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): cb616e2
- C (triage): cb616e2
- D (principal): cb616e2 — CI-hygiene fixes (CTO CI-triage routing #4484); no principal 1B1 — infra fixes, not a feature

## Review Summary

CI hygiene: bluebubbles Windows relative-root test fix + docker-release GHCR cache-ref lowercase; verified fmt/tsgo/lint 0/0, extensions 1953 pass
