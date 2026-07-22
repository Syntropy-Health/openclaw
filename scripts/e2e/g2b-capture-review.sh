#!/bin/bash
# ============================================================================
# [G2b] §7.4b-A live review — CAPTURE the matrix run into a durable, auditable,
# REDACTED evidence bundle (CTO #4372). Wraps g2b-revocation-harness.sh, slices
# the server-side observable per scenario, and writes one markdown bundle.
#
# TOKEN HYGIENE: no bearer is ever echoed by the harness, and this wrapper runs a
# hard redaction pass over BOTH the harness output and the gateway log slices —
# any Bearer <...>, eyJ… JWS, or sk_… secret is replaced with «REDACTED». The
# bundle is safe to attach/share.
#
# Usage (tokens handed to the ENV by shrinemobile at the window, never via file):
#   LIVE_JWT=.. LIVE_SID=.. LIVE_JWT_2=.. REMINT_ATTEMPTED=1 [LIVE_JWT_REMINT=..] \
#   TTL0_GATEWAY=1 SIM_UNREACHABLE=0 \
#   GW_LOG=/tmp/gw-review.log OUT=/tmp/g2b-review-bundle.md \
#   bash scripts/e2e/g2b-capture-review.sh
# ----------------------------------------------------------------------------
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GW_LOG="${GW_LOG:-/tmp/gw-review.log}"
OUT="${OUT:-/tmp/g2b-review-bundle.md}"
GIT_HEAD="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# Hard redaction: JWS tokens, Bearer values, Clerk secrets. Applied to everything.
redact() {
  sed -E \
    -e 's/(Bearer )[A-Za-z0-9._~+/-]+=*/\1«REDACTED»/g' \
    -e 's/eyJ[A-Za-z0-9._-]{10,}/«REDACTED-JWS»/g' \
    -e 's/sk_(test|live)_[A-Za-z0-9]+/«REDACTED-SECRET»/g' \
    -e 's/pk_(test|live)_[A-Za-z0-9]+/«REDACTED-PK»/g'
}

logslice() { grep -iE "clerk-session|mobile-signout" "$GW_LOG" 2>/dev/null | tail -"${1:-8}" | sed 's/\x1b\[[0-9;]*m//g' | redact; }

{
  echo "# [G2b] §7.4b-A revocation — live review evidence bundle"
  echo
  echo "- Gateway code: **openclaw @ ${GIT_HEAD}** (branch mangyinm/g2b-server-side-revocation)"
  echo "- Captured: (stamp applied by the caller — Date.now unavailable in-harness)"
  echo "- Server-side observable source: \`${GW_LOG}\` + Postgres \`openclaw_test\`"
  echo "- Token hygiene: bearers/JWS/secrets REDACTED in this bundle (verified by the redact pass)."
  echo
  echo "## Instance-match proof (caveat closed, CTO #4367)"
  echo "shrinemobile minted a real session on curious-gobbler-86 (pk_test) and resolved it via the"
  echo "Infisical dev sk_test through the Clerk Backend API → 200 status=active, same id. A"
  echo "different-instance key would 404. ⇒ the gateway's server-side lookups hit the RIGHT instance."
  echo
  echo "## Boot mode (revocation ACTIVE, not just compiled)"
  echo '```'
  grep -iE "clerk session validation" "$GW_LOG" 2>/dev/null | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | redact
  echo '```'
  echo
  echo "## Scenario matrix (expected vs actual + PASS/FAIL)"
  echo '```'
  GW_LOG="$GW_LOG" bash "$HERE/g2b-revocation-harness.sh" < /dev/null 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | redact
  echo '```'
  echo
  echo "## Server-side observable — trailing clerk-session / mobile-signout lines"
  echo '```'
  logslice 30
  echo '```'
  echo
  echo "## DB state (multi-device blast radius / bindings)"
  echo '```'
  PGPASSWORD="${PGPASSWORD:-postgres}" psql -h localhost -U postgres -d openclaw_test -tAc \
    "SELECT uc.channel, uc.channel_peer_id, u.external_id FROM lp_user_channels uc JOIN lp_users u ON u.id=uc.user_id ORDER BY uc.channel_peer_id;" 2>&1 | redact
  echo '```'
  echo
  echo "## Conscious substitutions / N-A marks (for the principal)"
  echo "- **Scenario 8** = REPLACED BY the per-request-re-auth proof (WS N/A by construction: mobile is"
  echo "  HTTP /v1/responses re-authorizing per request; WS carries no clerk-jwt). Substitute assertion:"
  echo "  TTL=0 → two turns each re-resolve independently + sign-out-between → turn-2 401. General"
  echo "  WS-hardening DEFERRED (A&D §7.4b-A req#2) with trigger 'when a WS chat client becomes"
  echo "  clerk-authorized, add the per-frame recheck then'."
  echo "- **Scenario 3** = source-level: the post-sign-out re-mint returns EMPTY (Clerk refuses to mint"
  echo "  for the revoked session) — stronger than a gateway 401; the pre-sign-out token → 401."
  echo
  echo "## Objective (§2.5)"
  echo "Met when scenarios 2,3,5,6 PASS + 7 structural + 9 alarmed + 4 bounded + 1/10 baseline,"
  echo "with 8 accepted as the per-request-re-auth substitute."
} > "$OUT" 2>&1

# Final safety net: fail LOUDLY if any un-redacted secret/JWS slipped into the bundle.
if grep -qE "eyJ[A-Za-z0-9._-]{10,}|sk_(test|live)_[A-Za-z0-9]{6,}|Bearer [A-Za-z0-9]" "$OUT"; then
  echo "‼️  ABORT: un-redacted secret/token detected in $OUT — NOT safe to share. Investigate." >&2
  exit 2
fi
echo "✅ evidence bundle written + redaction-verified: $OUT"
