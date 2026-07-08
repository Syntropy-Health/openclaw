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
hash_a: 444cfc727ab8fd58b9badad3b20fbeb4544b063f5cca7984fd476b50d58ac44c
hash_b: bcd183eb1d48f9ff433bae08b479d46f1ee7021448b39e8f4fefb4e619b0f744
hash_c: bf566b3c43e5125a477ba0810aeaf61410801951c06fa2e16d4f7c9737586458
hash_d: bf566b3c43e5125a477ba0810aeaf61410801951c06fa2e16d4f7c9737586458
hash_d_source: "principal directive relayed via devex (#2047) — cheapest Anthropic tier"
hash_e: 444cfc727ab8fd58b9badad3b20fbeb4544b063f5cca7984fd476b50d58ac44c
date: 2026-07-07T20:56
---

# Receipt: pr-prep — openclaw

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 444cfc7 — artifact entering the gate
- E (final):    444cfc7 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings):  bcd183e
- C (triage):    bf566b3
- D (principal): bf566b3 — principal directive relayed via devex (#2047) — cheapest Anthropic tier

## Review Summary
Committed model primary anthropic/claude-sonnet-4-5 -> anthropic/claude-haiku-4-5 (cheapest Anthropic; principal directive via devex #2047). Persists Haiku across volume recreates (devex had a runtime-only /data override). Same sub-processor (Anthropic direct, no-train) — no #1926 disclosure impact. QG: validateConfigObject ok, haiku-4-5 recognized + devex runtime-confirmed, guard 1/1, tsgo 0, sealed 60/60. diff-hash 444cfc7.
