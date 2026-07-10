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
hash_a: 9e0c315f8eed58f240fb36050f027df047b611496924d4e5021bf52e7dab4901
hash_b: 8fe920b26189206512a280420bfb66afc639d9187c4506d527ec6500a3dcbac9
hash_c: 43ceab062c1a8fd172be9230f88bca65dc842767e4ea1b549d68514f75223785
hash_d: 43ceab062c1a8fd172be9230f88bca65dc842767e4ea1b549d68514f75223785
hash_d_source: "auto-approved — build GO (#2190); final pre-land state per CTO #2547 (main reconciled + install-smoke assertion fix folded); supersedes 4d09854"
hash_e: 17ead6b634008fc7b4ce850ba9c5fd455e15f542f7425acca6c5bbf3044f12fb
date: 2026-07-10T03:38
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 9e0c315 — artifact entering the gate
- E (final): 17ead6b — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): 8fe920b
- C (triage): 43ceab0
- D (principal): 43ceab0 — auto-approved — build GO (#2190); final pre-land state per CTO #2547 (main reconciled + install-smoke assertion fix folded); supersedes 4d09854

## Review Summary

B1 gateway link FINAL (T1.1-T1.4 + CTO pre-land asks): main merged (behind 0), install-smoke version-parse fix; 264 tests, tsgo 0, sealed 60/60; live-proven vs kg-mcp-test
