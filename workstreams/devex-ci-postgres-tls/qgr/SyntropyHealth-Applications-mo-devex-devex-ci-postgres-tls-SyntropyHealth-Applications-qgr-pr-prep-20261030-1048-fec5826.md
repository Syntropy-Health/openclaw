---
receipt_version: 2
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: devex
workstream: devex-ci-postgres-tls
project: SyntropyHealth-Applications
diff_base: origin/main
hash_a: eaa753f23893de6f9967aa8b36bb2ebe1dfaa0e9259e76254274de64c80a4dea
hash_b: cda236e6c6a0ed877c2e080d6766bf100aedb54ea9e787c1c88bc27f2e558084
hash_c: d7dfc26ff3346a232d92631b2bc76daa8c1c72393258299749aa8fe5b49ef9b8
hash_d: d7dfc26ff3346a232d92631b2bc76daa8c1c72393258299749aa8fe5b49ef9b8
hash_d_source: "auto-approved — no principal 1B1"
hash_e: fec58261e07925bcbdc0a5640a4f318946b83a6b518e0a31c8e44c9faaca180a
date: 2026-10-30T10:48
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): eaa753f — artifact entering the gate
- E (final): fec5826 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): cda236e
- C (triage): d7dfc26
- D (principal): d7dfc26 — auto-approved — no principal 1B1

## Review Summary

CI runs the Postgres-backed extension integration suites (disposable TLS postgres:16) and fails if any of them skips
