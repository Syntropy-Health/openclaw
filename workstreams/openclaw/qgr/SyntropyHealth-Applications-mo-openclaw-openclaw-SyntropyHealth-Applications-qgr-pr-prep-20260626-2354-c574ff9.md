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
hash_a: bdeb353
hash_b: c574ff9
hash_c: c574ff9
hash_d: c574ff9
hash_d_source: "auto-approved — pr-prep gate, no principal 1B1"
hash_e: c574ff9
date: 2026-06-26T23:54
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): bdeb353 — artifact entering the gate
- E (final): c574ff9 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): c574ff9
- C (triage): c574ff9
- D (principal): c574ff9 — auto-approved — pr-prep gate, no principal 1B1

## Review Summary

chat-auth P1 B+C: Clerk-JWT verify on chat path + τ-metering activation (429/Retry-After per user_scope). 4-reviewer QG, 1 CRIT+1 MED+2 LOW fixed, 0 residual CRIT/HIGH; sealed 60/60, gateway unit 532/532, e2e 18/18.
