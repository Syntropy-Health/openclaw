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
hash_a: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
hash_b: fe49ff3a9cc0f93b9cd83d0bb184113f54396428717c67f278076aed6e2eb504
hash_c: 42c0e5eb9af292c8b2d69a6192c90c12c124c289f637634ef349d8e524eb474c
hash_d: d1c213cd2a9f5fd37b361499b390c265bb69a0e78c0abd494b66c901bf0d99e4
hash_d_source: "CTO ruling A on #4209 (fix the CODE, surface both)"
hash_e: b8c3cdd664c27bba7a0c649237955b2059462340c15f47204a0e01b5518166bd
date: 2026-07-22T04:35
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): e3b0c44 — artifact entering the gate
- E (final): b8c3cdd — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): fe49ff3
- C (triage): 42c0e5e
- D (principal): d1c213c — CTO ruling A on #4209 (fix the CODE, surface both)

## Review Summary

hard-gate CTA verification path + regression pins + append-path coverage; QG caught an unfollowable-instructions CRITICAL in my own first draft
