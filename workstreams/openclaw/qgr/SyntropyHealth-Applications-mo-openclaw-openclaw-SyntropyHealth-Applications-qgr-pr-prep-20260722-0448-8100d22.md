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
hash_a: 6dc40a398f703f39b09766d05f2beff59e805c40ad4f1a98fadadbeb07a9425e
hash_b: 6dc40a398f703f39b09766d05f2beff59e805c40ad4f1a98fadadbeb07a9425e
hash_c: a0aa0431f861ac82910fb285a67a85a3be506b6e36efb408b0fd96b8492d53e6
hash_d: a0aa0431f861ac82910fb285a67a85a3be506b6e36efb408b0fd96b8492d53e6
hash_d_source: "CTO CI-triage directive #4167/#4219 (auto-approved scope)"
hash_e: 8100d22d0ad9fefa394177bc4ad5c3e3d7f0521b879859ee5d2f2bfb9e1dfd1f
date: 2026-07-22T04:48
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 6dc40a3 — artifact entering the gate
- E (final): 8100d22 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): 6dc40a3
- C (triage): a0aa043
- D (principal): a0aa043 — CTO CI-triage directive #4167/#4219 (auto-approved scope)

## Review Summary

slack interactions order-dependence fixed; release-check diagnosed and routed to CTO version lane
