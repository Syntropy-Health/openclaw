---
receipt_version: 1
type: qgr
boundary: pr-prep
org: SyntropyHealth-Applications
principal: mo
agent: openclaw
workstream: openclaw-syntropy-agentic-chat
project: SyntropyHealth-Applications
diff_base: b63c2d21d8d6d04b450afe9ab2be66ccb9af7934
hash_a: bc800a13e19a19f18c54ea99fbb7fcceff6311162acf2df8ce51e100ac41698e
hash_b: bc800a13e19a19f18c54ea99fbb7fcceff6311162acf2df8ce51e100ac41698e
hash_c: bc800a13e19a19f18c54ea99fbb7fcceff6311162acf2df8ce51e100ac41698e
hash_d: bc800a13e19a19f18c54ea99fbb7fcceff6311162acf2df8ce51e100ac41698e
hash_d_source: "CTO #4550 ruling: Option A confirmed (default-on perCandidateTimeoutMs); no principal 1B1 — chat-robustness fix"
hash_e: bc800a13e19a19f18c54ea99fbb7fcceff6311162acf2df8ce51e100ac41698e
date: 2026-07-23T19:13
---

# Receipt: pr-prep — SyntropyHealth-Applications

## Verifiable hashes (recomputed + matched by receipt-verify)

- A (original): bc800a1 — artifact entering the gate
- E (final): bc800a1 — artifact after all fixes (verification anchor)

## Procedural attestation log (recorded, not independently verifiable)

These attest that each stage ran. Their inputs are ephemeral (review output,
triage notes, 1B1 transcripts) and cannot be reconstructed after the fact, so
they are a procedural log — NOT a cryptographic chain.

- B (findings): bc800a1
- C (triage): bc800a1
- D (principal): bc800a1 — CTO #4550 ruling: Option A confirmed (default-on perCandidateTimeoutMs); no principal 1B1 — chat-robustness fix

## Review Summary

issue #112 Option A: default-on perCandidateTimeoutMs (25s, env override kept) so a throttled primary fails over fast; +6 tests (incl injected-timer failover-fires); gateway 627, tsgo/lint 0/0. Only red = pre-existing #115 flake (untouched)
