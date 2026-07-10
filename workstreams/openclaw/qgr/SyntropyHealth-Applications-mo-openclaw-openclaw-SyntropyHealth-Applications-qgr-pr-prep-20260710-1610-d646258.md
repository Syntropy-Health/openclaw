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
hash_a: 82551113332e75706ed4326e73cf8bc88534dbbdab6dc638cd70028aed743685
hash_b: f957364cf312c067718fcb26e6c88f46111182d2973eb49d512b65595c0bf049
hash_c: fbec4a4cbfdffa42d93793c66eb032890874779445517d7d5b582b0cf3063ad9
hash_d: fbec4a4cbfdffa42d93793c66eb032890874779445517d7d5b582b0cf3063ad9
hash_d_source: "auto-approved — build GO (#2190); B4 security-critical, prod held; core-runner A4 touch flagged for CTO ratification in pr-submit"
hash_e: d6462582cb901ec08f01da440ecf37359a171b286fb9a6ba2e07c6f044cc9b6e
date: 2026-07-10T16:10
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): 8255111 — artifact entering the gate
- E (final): d646258 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): f957364
- C (triage): fbec4a4
- D (principal): fbec4a4 — auto-approved — build GO (#2190); B4 security-critical, prod held; core-runner A4 touch flagged for CTO ratification in pr-submit

## Review Summary

B4 Confirmation Governor (T4.1-4.4 + A4 producer bridge): the A&D CRIT fix (arg-reconstruction commit guard). 4-reviewer QG, 17 findings, 14>=80 all fixed incl. 2 commit-path fail-opens red-first (SEC-COLLISION surfaced-name gating + server-bind, CODE-STALE-EXTID cache invalidation). 743 tests, tsgo 0, sealed 60/60
