---
receipt_version: 1
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: openclaw
workstream: openclaw-syntropy-agentic-chat
project: SyntropyHealth-Applications
diff_base: c9e6bdf7ff446feaaf7ffc2c18d9e2fe92380e5f
hash_a: 4b68a60b321b3002c10a4b9df3cba9c1eb4dcdf1fee57726f23d35088c19fdc9
hash_b: 4b68a60b321b3002c10a4b9df3cba9c1eb4dcdf1fee57726f23d35088c19fdc9
hash_c: 4b68a60b321b3002c10a4b9df3cba9c1eb4dcdf1fee57726f23d35088c19fdc9
hash_d: 4b68a60b321b3002c10a4b9df3cba9c1eb4dcdf1fee57726f23d35088c19fdc9
hash_d_source: "CTO #4552 offered #115 as a ready-for-agent lane; no principal 1B1 — test-determinism fix"
hash_e: 4b68a60b321b3002c10a4b9df3cba9c1eb4dcdf1fee57726f23d35088c19fdc9
date: 2026-07-23T19:20
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 4b68a60 — artifact entering the gate
- E (final): 4b68a60 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): 4b68a60
- C (triage): 4b68a60
- D (principal): 4b68a60 — CTO #4552 offered #115 as a ready-for-agent lane; no principal 1B1 — test-determinism fix

## Review Summary

issue #115: de-flake model-fallback cooldown-skip e2e — cooldown expiry far beyond PROBE_MARGIN_MS (2min) makes the skip unconditional/wall-clock-independent; 30/30 green x3, tsgo/lint 0/0
