---
receipt_version: 1
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: openclaw
workstream: shrinemobile-live-gateway
project: SyntropyHealth-Applications
diff_base: 69205f8ca16e9d2f7ce1bdf61e5a78be7d2e4dc8
hash_a: 703925ca81890446265aa46afbd9cf2c68baf86d59e234abf56a09ed4d7c0c27
hash_b: 703925ca81890446265aa46afbd9cf2c68baf86d59e234abf56a09ed4d7c0c27
hash_c: 703925ca81890446265aa46afbd9cf2c68baf86d59e234abf56a09ed4d7c0c27
hash_d: 703925ca81890446265aa46afbd9cf2c68baf86d59e234abf56a09ed4d7c0c27
hash_d_source: "principal directive: create QA surface; test-harness only (bash), bash -n clean"
hash_e: 703925ca81890446265aa46afbd9cf2c68baf86d59e234abf56a09ed4d7c0c27
date: 2026-07-28T19:50
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 703925c — artifact entering the gate
- E (final): 703925c — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): 703925c
- C (triage): 703925c
- D (principal): 703925c — principal directive: create QA surface; test-harness only (bash), bash -n clean

## Review Summary

self-serve staging G-lane QA harness (scripts/e2e/staging-glane-qa.sh): mints dev-Clerk JWT via backend API + drives live staging bind+consent-kill; secret via env only, bash -n clean
