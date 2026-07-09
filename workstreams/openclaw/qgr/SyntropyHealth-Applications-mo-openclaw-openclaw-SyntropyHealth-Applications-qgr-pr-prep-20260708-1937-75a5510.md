---
receipt_version: 1
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: openclaw
workstream: openclaw
project: SyntropyHealth-Applications
diff_base: origin/main
hash_a: 987f1df162923e412c012ed6610faf40b95cfa689c4a947fca25a2371b6d11a7
hash_b: 1b575eb4ada3b7d68f839e4c8abfd4337877645b64a5f627287cc70a93fdde53
hash_c: 9ea4c9e346b59448a6816dee96edc8c01923f9831f21e7eba63ede5ffe34a612
hash_d: 9ea4c9e346b59448a6816dee96edc8c01923f9831f21e7eba63ede5ffe34a612
hash_d_source: "auto-approved — no principal 1B1 (B0 scaffold authorized by CTO #2186; land gate = CTO)"
hash_e: 75a551089ae91d989549312398dc9dbc957f867a0feaefb888caf9ff1b537d3a
date: 2026-07-08T19:37
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 987f1df — artifact entering the gate
- E (final): 75a5510 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): 1b575eb
- C (triage): 9ea4c9e
- D (principal): 9ea4c9e — auto-approved — no principal 1B1 (B0 scaffold authorized by CTO #2186; land gate = CTO)

## Review Summary

ComponentDescriptor v1 zod adapter + pact-lite contract test (C1/B0): 4-reviewer QG, 15 findings, 11 >=80 all fixed (SEC-1 proto-pollution guard red-first), 27/27 tests, tsgo 0, lint 0 own, sealed 60/60
