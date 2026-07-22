---
receipt_version: 1
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: openclaw
workstream: shrinemobile-live-gateway
project: SyntropyHealth-Applications
diff_base: origin/main
hash_a: 9f337e9c6afbfd8b948f9de538a838fdba09745a90f0fdb733ec3a22810f6447
hash_b: 9f337e9c6afbfd8b948f9de538a838fdba09745a90f0fdb733ec3a22810f6447
hash_c: dda9e14170b1a673f5ad841330cc145f54a3c952e8cfdb7d7159716b837c9686
hash_d: dda9e14170b1a673f5ad841330cc145f54a3c952e8cfdb7d7159716b837c9686
hash_d_source: "T1.4.1 live-verify failure #4259 (CTO-relayed, shrinemobile-observed)"
hash_e: 6f978e2e6028b595d6670020fbef54df67870322de50477234cc969d5b206b3f
date: 2026-07-22T05:58
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 9f337e9 — artifact entering the gate
- E (final): 6f978e2 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): 9f337e9
- C (triage): dda9e14
- D (principal): dda9e14 — T1.4.1 live-verify failure #4259 (CTO-relayed, shrinemobile-observed)

## Review Summary

[G1] hook-ctx channel fallback + handler-driven regression pins; R1a proven server-side
