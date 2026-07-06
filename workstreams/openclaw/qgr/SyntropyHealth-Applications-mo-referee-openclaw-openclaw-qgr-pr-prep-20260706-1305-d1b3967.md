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
hash_a: d1b39671d94f7ef644b871b94a3c7dd27c1247d035107500aaa5b5e11163d85f
hash_b: cc0af189cd5f1dcb0aa53ebb8b6086272021cf223b083bbd182e62a1398462bb
hash_c: be47460ba498b523d168b12d650e36054fe28f54e9ef7e8e855dd6264f442972
hash_d: be47460ba498b523d168b12d650e36054fe28f54e9ef7e8e855dd6264f442972
hash_d_source: "auto-approved — no principal 1B1 (compliance retention feature)"
hash_e: d1b39671d94f7ef644b871b94a3c7dd27c1247d035107500aaa5b5e11163d85f
date: 2026-07-06T13:05
---

# Receipt: pr-prep — openclaw

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): d1b3967 — artifact entering the gate
- E (final):    d1b3967 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings):  cc0af18
- C (triage):    be47460
- D (principal): be47460 — auto-approved — no principal 1B1 (compliance retention feature)

## Review Summary
persist-postgres transcript retention TTL (#1926 session-only): hourly sweep purges conversations + cascaded message content inactive > retentionDays; unref'd timer cleared on gateway_stop; staging retentionDays=1; default-off (backward-compat). QG: tsgo 0, persist-postgres 13/13 (5 new), sealed 60/60, oxlint N/A (extensions-ignored). diff-hash d1b3967.
