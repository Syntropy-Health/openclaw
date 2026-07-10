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
hash_d_source: "auto-approved — no principal 1B1 (build GO ratified at the A&D gate, dispatch #2190)"
hash_e: 921df67879af596d2a75432edc83a335145393c42b0439dc282ddc24975b9845
date: 2026-07-08T20:20
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 9e0c315 — artifact entering the gate
- E (final): 921df67 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): 8fe920b
- C (triage): 43ceab0
- D (principal): 43ceab0 — auto-approved — no principal 1B1 (build GO ratified at the A&D gate, dispatch #2190)

## Review Summary

B1 gateway link (T1.1-T1.3): listMcpTools + ToolCatalog + SyntropyMcpPlugin; 4-reviewer QG 26 findings, 1 >=80 (SEC-B1-1 max-stale fail-open) fixed red-first + 4 folded; 33+8 tests, tsgo 0, lint 0 own, sealed 60/60
