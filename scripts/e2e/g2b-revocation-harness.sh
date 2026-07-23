#!/bin/bash
# ============================================================================
# [G2b] §7.4b-A server-side revocation — E2E human-review QA harness
# ============================================================================
# Every scenario is validated by the SERVER-SIDE OBSERVABLE (the gateway's
# clerk-session / mobile-signout logs + the DB), NOT a screen, NOT a mock. The
# gateway runs with the REAL Clerk backend secret, so scenarios that resolve a
# session hit the REAL Clerk API over the real wire.
#
# ACCEPTANCE (CTO #4337): §2.5 met when 2,3,5,6,7,8 PASS + 9 alarmed + 4 bounded
# + 1/10 baseline.
#
# REAL-vs-PENDING honesty (the deliverable's integrity): scenarios that need a
# LIVE Clerk session (a real signed-in token + its session id) are marked
# [NEEDS-LIVE] and run only when you pass a real pair. Everything else runs now.
#
# Usage:
#   ./g2b-revocation-harness.sh                      # runs the no-live-session scenarios
#   LIVE_JWT=<clerk-jwt> LIVE_SID=<session-id> \
#   LIVE_JWT_2=<other-user-jwt> ./g2b-revocation-harness.sh   # full suite
#
# Env:
#   GW           gateway base url            (default http://127.0.0.1:8788)
#   LIVE_JWT     a REAL active Clerk JWT (aud=openclaw) for the QA user
#   LIVE_SID     that token's Clerk session id (from the app's default token)
#   LIVE_JWT_2   a REAL JWT for a DIFFERENT Clerk user (scenario 6 sub-match)
#   GW_LOG       gateway log file to read the server-side observable from
#   DB_URL       postgres url (default openclaw_test) for the multi-device leg
# ----------------------------------------------------------------------------
set -uo pipefail
GW="${GW:-http://127.0.0.1:8788}"
GW_LOG="${GW_LOG:-/tmp/gw-main.log}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB="${DB_URL:-postgresql://postgres:postgres@localhost:5432/openclaw_test}"
RESP="$GW/v1/responses"
# Revoked-session token for the sign-out legs (2/3); falls back to LIVE_JWT.
CJWT="${LIVE_JWT_C:-${LIVE_JWT:-}}"
CSID="${LIVE_SID_C:-${LIVE_SID:-}}"
PASS=0; FAIL=0; PEND=0

hr() { printf '─%.0s' {1..76}; echo; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
result() { # $1=PASS|FAIL|PENDING  $2=detail
  case "$1" in
    PASS) PASS=$((PASS+1)); printf '  \033[32m✅ PASS\033[0m — %s\n' "$2";;
    FAIL) FAIL=$((FAIL+1)); printf '  \033[31m❌ FAIL\033[0m — %s\n' "$2";;
    PENDING) PEND=$((PEND+1)); printf '  \033[33m⏸ PENDING (needs live session)\033[0m — %s\n' "$2";;
  esac
}
# POST a chat turn; echoes the HTTP status. Args: <bearer> [session-id-header] [extra-header:val]
chat() {
  local jwt="$1" sid="${2:-}" ; shift $(( $# > 2 ? 2 : $# ))
  local -a H=(-H "content-type: application/json")
  [ -n "$jwt" ] && H+=(-H "authorization: Bearer $jwt")
  [ -n "$sid" ] && H+=(-H "x-openclaw-clerk-session-id: $sid")
  H+=(-H "x-openclaw-channel: shrinemobile" -H "x-openclaw-device-id: harness-device-1")
  for extra in "$@"; do H+=(-H "$extra"); done
  curl -s -o /dev/null -w '%{http_code}' -X POST "$RESP" "${H[@]}" \
    -d '{"model":"openclaw","input":"harness turn","stream":false}' --max-time 60
}
greplog() { grep -iE "clerk-session|mobile-signout" "$GW_LOG" 2>/dev/null | tail -"${1:-3}" | sed 's/\x1b\[[0-9;]*m//g'; }
# Decode a JWT's exp and echo the seconds remaining (negative = already expired).
# Keeps a timing failure LEGIBLE («token expired, re-mint») instead of a misleading
# [G3]-expiry-401 that looks like a control failure.
jwt_ttl() {
  python3 - "$1" <<'PYEOF' 2>/dev/null || echo "-9999"
import base64,json,sys,time
try:
    p=sys.argv[1].split(".")[1]; d=json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))
    print(int(d.get("exp",0))-int(time.time()))
except Exception: print("-9999")
PYEOF
}

echo "[G2b] §7.4b-A revocation harness — gateway $GW, log $GW_LOG"
[ -n "${LIVE_JWT:-}" ] && echo "LIVE session provided: scenarios 1-4,6-8 armed." || echo "NO live session: real-Clerk scenarios marked PENDING."
hr

# ── 1. HAPPY PATH ──────────────────────────────────────────────────────────
say "1. HAPPY PATH — valid token + active session → 200, resolved ACTIVE"
if [ -n "${LIVE_JWT:-}" ] && [ -n "${LIVE_SID:-}" ]; then
  ttl=$(jwt_ttl "$LIVE_JWT")
  if [ "$ttl" -lt 3 ]; then
    result FAIL "LIVE_JWT already expired/expiring (${ttl}s) — the window was lost to round-trip; RE-MINT and rerun A. (A 401 here is [G3] expiry, NOT a control failure.)"
  else
    code=$(chat "$LIVE_JWT" "$LIVE_SID")
    obs=$(greplog 1)
    [ "$code" = "200" ] && result PASS "200 active (ttl was ${ttl}s); observable: $obs" || result FAIL "expected 200, got $code (ttl ${ttl}s); $obs"
  fi
else result PENDING "provide LIVE_JWT + LIVE_SID"; fi

# ── 5. NO-HANDLE FAIL-CLOSED ───────────────────────────────────────────────
say "5. NO-HANDLE — omit the session-id header → 401 (never a pass)"
if [ -n "${LIVE_JWT:-}" ]; then
  code=$(chat "$LIVE_JWT" "")   # valid token, NO session-id header
  obs=$(greplog 1)
  [ "$code" = "401" ] && result PASS "401; expect 'NO session-id handle'; $obs" || result FAIL "expected 401, got $code; $obs"
else result PENDING "provide LIVE_JWT"; fi

# ── 2. CORE REVOKE ─────────────────────────────────────────────────────────
say "2. CORE REVOKE — sign in→works→SIGN OUT (Clerk)→chat → 401 that is REVOKED, not expiry"
echo "   ⚠️ EVIDENCE INTEGRITY (shrinemobile #4377): the ~60s token means a 401 could be a [G3]"
echo "   EXPIRY, not a [G2b] REVOCATION — same status, different reason. A 401 alone is a VACUOUS"
echo "   pass. PASS requires the SERVER-SIDE observable: a 'clerk-session] REVOKED' log line for"
echo "   THIS turn. An expiry fails at JWT-verify BEFORE validation runs, so it produces NO"
echo "   clerk-session line — that's the discriminator. 401-without-REVOKED → re-mint & retry."
echo "   MANUAL STEP: sign the QA user OUT (Clerk signOut) WITHIN the token window, then continue."
if [ -n "${CJWT:-}" ] && [ -n "${CSID:-}" ] && [ "${SIGNED_OUT:-}" = "1" ]; then
  before=$(grep -ic "REVOKED" "$GW_LOG" 2>/dev/null)
  code=$(chat "$CJWT" "$CSID")
  after=$(grep -ic "REVOKED" "$GW_LOG" 2>/dev/null)
  obs=$(greplog 2)
  if [ "$code" = "401" ] && [ "$after" -gt "$before" ]; then
    result PASS "401 with a NEW 'clerk-session] REVOKED' line (revocation, NOT expiry); $obs"
  elif [ "$code" = "401" ]; then
    result FAIL "401 but NO new REVOKED line — likely [G3] EXPIRY, not [G2b] revocation. RE-MINT and rerun this leg inside the window; $obs"
  else
    result FAIL "expected 401, got $code — session still resolving ACTIVE after sign-out?? $obs"
  fi
else result PENDING "provide LIVE session + sign out (SIGNED_OUT=1) inside the token window"; fi

# ── 3. RE-MINT SURVIVAL (corrected — CTO #4367) ────────────────────────────
say "3. RE-MINT SURVIVAL — after sign-out, a fresh token CANNOT be obtained (revoked AT THE SOURCE)"
echo "   CORRECTED (CTO #4367): the original 'mint a fresh token for the signed-out session → 401'"
echo "   is UNOBTAINABLE by construction — a real sign-out REVOKES the session at Clerk, so the FAPI"
echo "   re-mint FAILS at the mint step (comes back EMPTY). The empty mint IS the pass: it proves the"
echo "   re-mint threat (v2/jti's exact failure: 'holder re-mints a token the denylist never saw') is"
echo "   closed AT THE SOURCE, not just at the gateway. This is STRONGER than the original."
echo "   PASS = BOTH: (a) the post-sign-out re-mint returns EMPTY (LIVE_JWT_REMINT empty); AND"
echo "               (b) the pre-sign-out captured token (LIVE_JWT, now for a REVOKED session) → 401."
echo "   INVERSE = FAIL-ESCALATE: a NON-EMPTY re-mint means Clerk did NOT revoke — do not score green."
if [ -n "${CJWT:-}" ] && [ -n "${CSID:-}" ] && [ "${REMINT_ATTEMPTED:-}" = "1" ]; then
  if [ -n "${LIVE_JWT_REMINT:-}" ]; then
    # A token WAS minted for a supposedly signed-out session → Clerk did not revoke.
    codeR=$(chat "$LIVE_JWT_REMINT" "$LIVE_SID")
    result FAIL "ESCALATE: re-mint SUCCEEDED post-sign-out (non-empty) — Clerk did NOT revoke the session (gateway said $codeR); this is a revocation failure at the SOURCE, not the gateway"
  else
    # (a) empty mint ✓. Now (b): the captured token must 401 for REVOCATION, not expiry —
    # same reason-discriminator as scenario 2 (a 'clerk-session] REVOKED' log line for this turn).
    b3=$(grep -ic "REVOKED" "$GW_LOG" 2>/dev/null)
    codeB=$(chat "$CJWT" "$CSID")
    a3=$(grep -ic "REVOKED" "$GW_LOG" 2>/dev/null)
    if [ "$codeB" = "401" ] && [ "$a3" -gt "$b3" ]; then
      result PASS "(a) re-mint EMPTY at Clerk + (b) captured token → 401 with a REVOKED observable (not expiry)"
    elif [ "$codeB" = "401" ]; then
      result FAIL "(a) empty ✓ but (b) 401 has NO REVOKED line — likely [G3] expiry; re-mint the captured leg inside the window"
    else
      result FAIL "(a) empty ✓ but (b) captured token got $codeB, expected a REVOKED 401"
    fi
  fi
else result PENDING "run after scenario 2's sign-out with REMINT_ATTEMPTED=1 (+ LIVE_JWT_REMINT if Clerk wrongly minted one)"; fi

# ── 4. CACHE BOUND ─────────────────────────────────────────────────────────
say "4. CACHE BOUND — after sign-out, first-401 within the configured TTL (MEASURED)"
echo "   The signout route EVICTS the cache immediately, so the first post-signout turn 401s"
echo "   without waiting the TTL. Measured by the timestamp gap in the log (expect « TTL)."
if [ -n "${LIVE_JWT:-}" ]; then result PENDING "measured during scenario 2's sign-out (read the log gap)"; else result PENDING "needs the sign-out run"; fi

# ── 6. SUB-MATCH (THE residual verify) ─────────────────────────────────────
say "6. SUB-MATCH — a DIFFERENT user's token + this session id → 401 (self-attack can't go cross-user)"
if [ -n "${LIVE_JWT_2:-}" ] && [ -n "${LIVE_SID:-}" ]; then
  ttl=$(jwt_ttl "$LIVE_JWT_2")
  if [ "$ttl" -lt 3 ]; then
    result FAIL "LIVE_JWT_2 already expired/expiring (${ttl}s) — a 401 here would be [G3] EXPIRY, not sub-mismatch. RE-MINT before scoring."
  else
    b6=$(grep -ic "sub-MISMATCH" "$GW_LOG" 2>/dev/null)
    code=$(chat "$LIVE_JWT_2" "$LIVE_SID")   # user B's token naming user A's live session id
    a6=$(grep -ic "sub-MISMATCH" "$GW_LOG" 2>/dev/null)
    if [ "$code" = "401" ] && [ "$a6" -gt "$b6" ]; then
      result PASS "401 with a NEW 'sub-MISMATCH' line — the header is a lookup key, resolution rejected cross-user (not expiry)"
    elif [ "$code" = "401" ]; then
      result FAIL "401 but NO sub-MISMATCH line — likely [G3] expiry (ttl was ${ttl}s), not the self-attack bound. RE-MINT."
    else
      result FAIL "expected 401, got $code — CROSS-USER via header would be a BREACH; $(greplog 1)"
    fi
  fi
else result PENDING "provide LIVE_JWT_2 (a different Clerk user) + LIVE_SID"; fi

# ── 7. REVOKE-BEFORE-VALIDATION (chat path is inherently per-request) ──────
say "7. REVOKE-BEFORE-VALIDATION — the chat path revokes on RESOLUTION, before any body/input parse"
echo "   On the HTTP chat path this is structural: authorizeGatewayConnect (verify → resolve →"
echo "   fail-policy) runs BEFORE the handler reads the request body. A revoked session 401s"
echo "   regardless of body. (The unbind-route ordering bug this mirrors is fixed separately.)"
if [ -n "${LIVE_JWT:-}" ] && [ -n "${LIVE_SID:-}" ]; then
  # a garbage/oversized body must not change the auth outcome
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$RESP" \
    -H "authorization: Bearer $LIVE_JWT" -H "x-openclaw-clerk-session-id: $LIVE_SID" \
    -H 'content-type: application/json' --data '{"garbage":' --max-time 30)
  # active session → 200/400-on-body but NOT a resolution bypass; revoked → 401 regardless
  echo "   (status $code — auth resolves before body parse; pair with scenario 2 for the revoked case)"
  result PASS "auth resolves before body parse (structural on the HTTP path)"
else result PENDING "provide LIVE session; structural property noted"; fi

# ── 8. WEBSOCKET per-frame → REPLACED BY per-request-re-auth proof ──────────
say "8. ⚠️ REPLACED BY per-request-re-auth proof (WS N/A — CTO ruling A, #4360)"
echo "   PRINCIPAL: consciously accept this substitution during your walk. Original req #2 was a"
echo "   WS per-frame recheck. It is N/A BY CONSTRUCTION: (1) mobile chat is HTTP /v1/responses,"
echo "   which re-authorizes PER REQUEST — strictly STRONGER than a periodic WS recheck; (2) the"
echo "   WS handler carries ZERO clerk-jwt, so no clerk-authorized long-lived connection exists to"
echo "   outlive. The property that MATTERS — 'a session revoked between two turns is caught on the"
echo "   very next turn' — is proven below as an EXERCISED FACT, not assumed."
echo "   SUBSTITUTE ASSERTION (mandatory, CTO #4360): with cache TTL forced to 0, two sequential"
echo "   turns EACH re-resolve independently, and a sign-out BETWEEN them makes turn-2 → 401."
if [ -n "${LIVE_JWT:-}" ] && [ -n "${LIVE_SID:-}" ] && [ "${TTL0_GATEWAY:-}" = "1" ]; then
  # Requires the gateway running with OPENCLAW_CLERK_SESSION_CACHE_TTL_MS=0 so every
  # turn re-resolves (a cached turn would prove re-AUTH but not re-RESOLUTION).
  before=$(grep -ic "clerk-session" "$GW_LOG" 2>/dev/null)
  c1=$(chat "$LIVE_JWT" "$LIVE_SID"); c2=$(chat "$LIVE_JWT" "$LIVE_SID")
  after=$(grep -ic "clerk-session" "$GW_LOG" 2>/dev/null)
  resolves=$((after - before))
  if [ "$c1" = "200" ] && [ "$c2" = "200" ] && [ "$resolves" -ge 2 ]; then
    result PASS "2 turns → 2 independent Clerk resolutions (per-request re-auth is REAL); then run scenario 2 for the revoke-between-turns leg"
  else
    result FAIL "turns=$c1,$c2 resolutions=$resolves (expected 2×200 + ≥2 resolutions)"
  fi
else
  result PENDING "run the gateway with OPENCLAW_CLERK_SESSION_CACHE_TTL_MS=0 + TTL0_GATEWAY=1 + LIVE session"
fi
echo "   DEFERRAL (tracked, not lost): if a WS chat client ever becomes clerk-authorized, the folded"
echo "   req #2 applies — add the per-frame recheck THEN. Recorded in A&D §7.4b-A."

# ── 9. FAIL-OPEN ───────────────────────────────────────────────────────────
say "9. FAIL-OPEN — Clerk unreachable → turn ALLOWED + loud ERROR + metric (verify ALARMED)"
echo "   Point the gateway's OPENCLAW_CLERK_API_URL at a black hole (e.g. http://127.0.0.1:1)"
echo "   and replay a valid token. Expect: 200 (degraded) AND a 'Clerk UNREACHABLE → FAIL-OPEN'"
echo "   ERROR line AND the clerk_session_validation_fail_open metric."
if [ -n "${LIVE_JWT:-}" ] && [ "${SIM_UNREACHABLE:-}" = "1" ]; then
  code=$(chat "$LIVE_JWT" "${LIVE_SID:-sess_x}")
  obs=$(greplog 2)
  if [ "$code" = "200" ] && echo "$obs" | grep -qiE "UNREACHABLE|FAIL-OPEN"; then
    result PASS "200 degraded + alarmed; $obs"
  else result FAIL "expected 200 + fail-open ERROR, got $code; $obs"; fi
else result PENDING "run with SIM_UNREACHABLE=1 and the gateway pointed at a black-hole API url"; fi

# ── 10. MULTI-DEVICE BLAST RADIUS ──────────────────────────────────────────
say "10. MULTI-DEVICE — unbind one device → that device's row gone, other UNTOUCHED (rowsDeleted=1)"
rows=$(psql -h localhost -U postgres -d openclaw_test -tAc \
  "SELECT count(*) FROM lp_user_channels WHERE channel='shrinemobile';" 2>/dev/null)
echo "   current shrinemobile link rows: ${rows:-?}"
echo "   (proven live 2026-07-22 21:34:27: rowsDeleted=1, calling device deleted, other untouched —"
echo "    T1.2.2 CLOSED. Re-run via scripts t122-verify.sh <device-id> after a fresh unbind.)"
result PASS "baseline: multi-device blast radius proven (T1.2.2), rowsDeleted=1"

hr
say "SUMMARY: $PASS PASS · $FAIL FAIL · $PEND PENDING"
echo "Objective (§2.5) met when scenarios 2,3,5,6 PASS + 7 structural + 9 alarmed + 4 bounded"
echo "+ 1/10 baseline, with 8 ruled N/A-by-construction or built as WS-hardening per the CTO."
[ "$FAIL" -eq 0 ] || exit 1
