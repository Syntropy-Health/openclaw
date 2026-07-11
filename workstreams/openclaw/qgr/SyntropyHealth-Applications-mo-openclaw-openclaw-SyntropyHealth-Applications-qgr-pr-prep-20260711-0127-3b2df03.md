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
hash_a: db9fde32bc8d80656742cfa6cc3090669fa8110ea70d30c32e79a9dbe48fa71b
hash_b: af1c370d4bb876a4d8fdd0ca0fe824f4d9505534badb57a9846dafa83c261448
hash_c: b75272292504ef8a01bc258f234c2d1bbd68a11610647bb9feeeccb22f374ed0
hash_d: b75272292504ef8a01bc258f234c2d1bbd68a11610647bb9feeeccb22f374ed0
hash_d_source: "auto-approved — build GO (#2190); B5 PHI-egress boundary, prod held; CTO fail-closed gate satisfied"
hash_e: 3b2df031ed5bf793afa0249c812cf0dd05e8645716abc9bb32a9d1fb3c33eb95
date: 2026-07-11T01:27
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): db9fde3 — artifact entering the gate
- E (final): 3b2df03 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): af1c370
- C (triage): b752722
- D (principal): b752722 — auto-approved — build GO (#2190); B5 PHI-egress boundary, prod held; CTO fail-closed gate satisfied

## Review Summary

B5 ChannelRenderingPolicy (R7 PHI-egress) — 4-reviewer QG + 1 security re-QG on a HIPAA boundary. CRITICAL (field-detection minimization) + 2 HIGH (parse-fail fail-open, nav-passthrough bypass) all fixed red-first. FINAL fully fail-closed: full ui.summary ONLY for explicitly-phiApproved non-denylisted channels; every other case minimizes+drops media; no producer-controlled egress. 24+36 tests, sealed 60/60
