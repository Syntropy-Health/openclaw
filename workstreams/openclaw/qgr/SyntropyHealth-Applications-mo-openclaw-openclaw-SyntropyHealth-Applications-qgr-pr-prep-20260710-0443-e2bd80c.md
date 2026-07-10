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
hash_a: e2bd80cb9846d419fa0a91490e8b7ffa87f9b8e17602018c23c828447f20c541
hash_b: e2bd80cb9846d419fa0a91490e8b7ffa87f9b8e17602018c23c828447f20c541
hash_c: e2bd80cb9846d419fa0a91490e8b7ffa87f9b8e17602018c23c828447f20c541
hash_d: e2bd80cb9846d419fa0a91490e8b7ffa87f9b8e17602018c23c828447f20c541
hash_d_source: "auto-approved — CI-harness assertion fix, no app code; verified via regex proof on both --version formats + bash -n"
hash_e: e2bd80cb9846d419fa0a91490e8b7ffa87f9b8e17602018c23c828447f20c541
date: 2026-07-10T04:43
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): e2bd80c — artifact entering the gate
- E (final): e2bd80c — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): e2bd80c
- C (triage): e2bd80c
- D (principal): e2bd80c — auto-approved — CI-harness assertion fix, no app code; verified via regex proof on both --version formats + bash -n

## Review Summary

install-sh-smoke version-parse fix — the REAL install-smoke.yml assertion (B1 fixed the wrong sibling harness)
