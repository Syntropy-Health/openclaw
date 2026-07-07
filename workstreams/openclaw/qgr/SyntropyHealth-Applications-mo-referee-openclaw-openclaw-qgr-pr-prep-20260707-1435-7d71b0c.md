---
receipt_version: 1
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: referee
workstream: openclaw
project: openclaw
diff_base: origin/main
hash_a: 7d71b0c49d9d7eac7a753fc08a0e59e4c9f49af249e8871d7d0504759a81bb52
hash_b: 1de69f029c8eaf5f575d338cd431b0441685ef2d0e32d76d5a9654a76d7c51de
hash_c: 9b3a9b05781add1bc53ac26a8d5f31fe30f2b7069b8ae75453553416e600c7d0
hash_d: 9b3a9b05781add1bc53ac26a8d5f31fe30f2b7069b8ae75453553416e600c7d0
hash_d_source: "auto-approved — no principal 1B1 (staging transport restore)"
hash_e: 7d71b0c49d9d7eac7a753fc08a0e59e4c9f49af249e8871d7d0504759a81bb52
date: 2026-07-07T14:35
---

# Receipt: pr-prep — openclaw

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 7d71b0c — artifact entering the gate
- E (final):    7d71b0c — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings):  1de69f0
- C (triage):    9b3a9b0
- D (principal): 9b3a9b0 — auto-approved — no principal 1B1 (staging transport restore)

## Review Summary
Enable gateway.http.endpoints.responses + chatCompletions in committed openclaw.json — restores /v1/responses (+ /v1/chat/completions) for the mobile chat integration (dropped when the fresh openclaw_data volume reseeded from a committed config that lacked the gateway.http block; endpoint enablement is config-only, no env). Verified validateConfigObject ok:true + resolution serves /v1/responses. CORS origins remain env (OPENCLAW_HTTP_CORS_ORIGINS, devex). QG: tsgo 0, guard test 1/1, sealed 60/60. diff-hash 7d71b0c.
