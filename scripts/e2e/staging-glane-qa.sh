#!/usr/bin/env bash
# ============================================================================
# SELF-SERVE G-LANE QA SURFACE (staging) — mint a real dev-Clerk JWT and drive
# the LIVE gateway through the full G-lane: [G1] auto-bind + [G2b] consent-kill.
#
# WHY THIS EXISTS: the OpenClaw Control UI on the staging host does NOT do Clerk
# sign-in (its bootstrap config carries no auth), so it cannot exercise the
# G-lane. And the gateway only accepts a real Clerk JWT — which historically only
# shrinemobile's sign-in could mint, so QA was blocked on an external emulator.
# This harness removes that dependency: it mints its own dev-Clerk session JWT
# via the Clerk Backend API, then verifies the G-lane end-to-end against the live
# staging gateway. One command, repeatable, no mobile build required.
#
# WHAT IT PROVES (against the LIVE staging URL):
#   1. [G1] a verified-Clerk /v1/responses turn is ACCEPTED (200) and auto-binds
#      an lp_user_channels row (channel + device peer) for the token's sub.
#   2. [G2b] after the Clerk session is REVOKED (sign-out), the SAME still-crypto-
#      valid token is REJECTED (401) — consent-kill, provably revocation not expiry
#      (the token's exp is still in the future).
#
# SECRET HYGIENE (non-negotiable): the Clerk secret key is read from the ENV only
# (OPENCLAW_CLERK_SECRET_KEY) and is NEVER printed (length-only debug at most).
# Minted JWTs are bearer secrets too — this harness never echoes them (it prints
# only lengths / decoded non-secret claims). Run it so the secret is injected at
# runtime and never lands in a shell history or a transcript, e.g.:
#
#   infisical run --env=dev --path=<clerk-secret-path> -- \
#     bash scripts/e2e/staging-glane-qa.sh
#
# or export OPENCLAW_CLERK_SECRET_KEY yourself from a secure source first.
#
# ENV (all overridable; only OPENCLAW_CLERK_SECRET_KEY is required):
#   OPENCLAW_CLERK_SECRET_KEY   dev sk_test_… for curious-gobbler-86       (REQUIRED)
#   CLERK_API                   Clerk backend API   (default api.clerk.com)
#   CLERK_FAPI                  Clerk frontend/instance base
#                               (default https://curious-gobbler-86.clerk.accounts.dev)
#   CLERK_TEMPLATE              JWT template name   (default openclaw; aud=openclaw)
#   STAGING                     gateway base url
#                               (default https://shrine-openclaw-chat-staging.fly.dev)
#   QA_EMAIL                    test user email; use a +clerk_test address for
#                               deterministic, no-real-inbox creation
#                               (default qa+clerk_test@syntropyhealth.bio)
#   QA_DEVICE                   X-OpenClaw-Device-Id = the channel_peer_id bound
#                               (default qa-glane-device)
#   QA_CHANNEL                  X-OpenClaw-Channel    (default shrinemobile)
#   DB_URL                      OPTIONAL staging Postgres URL — if set, the bind
#                               row is asserted directly in lp_user_channels;
#                               otherwise the 200 is the bind signal + a note.
# ----------------------------------------------------------------------------
set -uo pipefail

# ---- config ----------------------------------------------------------------
SK="${OPENCLAW_CLERK_SECRET_KEY:-}"
CLERK_API="${CLERK_API:-https://api.clerk.com}"
CLERK_FAPI="${CLERK_FAPI:-https://curious-gobbler-86.clerk.accounts.dev}"
TEMPLATE="${CLERK_TEMPLATE:-openclaw}"
STAGING="${STAGING:-https://shrine-openclaw-chat-staging.fly.dev}"
QA_EMAIL="${QA_EMAIL:-qa+clerk_test@syntropyhealth.bio}"
QA_DEVICE="${QA_DEVICE:-qa-glane-device}"
QA_CHANNEL="${QA_CHANNEL:-shrinemobile}"
DB_URL="${DB_URL:-}"
RESP="$STAGING/v1/responses"

PASS=0; FAIL=0
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '  \033[2m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mABORT:\033[0m %s\n' "$*" >&2; exit 2; }

command -v jq   >/dev/null 2>&1 || die "jq is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
[ -n "$SK" ] || die "OPENCLAW_CLERK_SECRET_KEY is unset — inject it (e.g. via 'infisical run'). Never hard-code it."
case "$SK" in sk_*) : ;; *) die "OPENCLAW_CLERK_SECRET_KEY does not look like a Clerk secret (sk_*)";; esac
note "gateway   = $STAGING"
note "clerk fapi= $CLERK_FAPI   template=$TEMPLATE   sk len=${#SK}"
note "qa user   = $QA_EMAIL   device(peer)=$QA_DEVICE   channel=$QA_CHANNEL"

bapi() { # backend API call: bapi METHOD PATH [curl-args...]
  local m="$1" p="$2"; shift 2
  curl -s -X "$m" "$CLERK_API$p" -H "authorization: Bearer $SK" "$@"
}

# ---- 1. test user (find or create; +clerk_test = deterministic, no real inbox)
say "1. Resolve the QA test user ($QA_EMAIL)"
users="$(bapi GET "/v1/users?email_address=$(jq -rn --arg e "$QA_EMAIL" '$e|@uri')&limit=1")"
uid="$(printf '%s' "$users" | jq -r 'if type=="array" then (.[0].id // empty) else empty end')"
if [ -z "$uid" ]; then
  note "no existing user — creating one"
  created="$(bapi POST /v1/users -H 'content-type: application/json' \
    -d "$(jq -n --arg e "$QA_EMAIL" '{email_address:[$e], skip_password_requirement:true, skip_password_checks:true}')")"
  uid="$(printf '%s' "$created" | jq -r '.id // empty')"
  [ -n "$uid" ] || die "could not create test user. Clerk said: $(printf '%s' "$created" | jq -c '.errors // .' 2>/dev/null | head -c 400)"
fi
ok "test user resolved (id len=${#uid})"

# ---- 2. sign-in token (backend) -> 3. native ticket exchange (frontend) -> sid
say "2. Mint a Clerk session for the user (sign-in token -> native ticket exchange)"
sit="$(bapi POST /v1/sign_in_tokens -H 'content-type: application/json' -d "$(jq -n --arg u "$uid" '{user_id:$u}')")"
ticket="$(printf '%s' "$sit" | jq -r '.token // empty')"
[ -n "$ticket" ] || die "sign_in_tokens failed: $(printf '%s' "$sit" | jq -c '.errors // .' 2>/dev/null | head -c 400)"
exch="$(curl -s -X POST "$CLERK_FAPI/v1/client/sign_ins?_is_native=1" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "strategy=ticket" --data-urlencode "ticket=$ticket")"
sid="$(printf '%s' "$exch" | jq -r '.response.created_session_id // .client.sessions[0].id // empty')"
[ -n "$sid" ] || die "ticket exchange did not yield a session id. Response head: $(printf '%s' "$exch" | jq -c '{status:.response.status, err:(.errors//empty)}' 2>/dev/null | head -c 400)"
ok "session created (sid len=${#sid})"

# ---- 4. mint the openclaw-template JWT (aud=openclaw) for that session --------
say "4. Mint the '$TEMPLATE' template JWT (aud=$TEMPLATE)"
tok="$(bapi POST "/v1/sessions/$sid/tokens/$TEMPLATE" -H 'content-type: application/json' -d '{}')"
jwt="$(printf '%s' "$tok" | jq -r '.jwt // empty')"
[ -n "$jwt" ] || die "template token mint failed (does the '$TEMPLATE' JWT template exist on this instance?): $(printf '%s' "$tok" | jq -c '.errors // .' 2>/dev/null | head -c 400)"
# Decode + show NON-SECRET claims only (never the token). Confirms aud/iss/exp.
claims="$(printf '%s' "$jwt" | cut -d. -f2 | tr '_-' '/+' | { p="$(cat)"; case $(( ${#p} % 4 )) in 2) p="$p==";; 3) p="$p=";; esac; printf '%s' "$p"; } | base64 -d 2>/dev/null)"
aud="$(printf '%s' "$claims" | jq -r '.aud // empty' 2>/dev/null)"
sub="$(printf '%s' "$claims" | jq -r '.sub // empty' 2>/dev/null)"
exp="$(printf '%s' "$claims" | jq -r '.exp // empty' 2>/dev/null)"
now="$(date +%s)"
ttl=$(( ${exp:-0} - now ))
ok "JWT minted (len=${#jwt}); claims: aud=$aud sub=(len ${#sub}) ttl=${ttl}s"
[ "$aud" = "$TEMPLATE" ] && ok "aud == $TEMPLATE (gateway will accept it)" || bad "aud '$aud' != $TEMPLATE — the gateway's OPENCLAW_CLERK_AUDIENCE must match"

# ---- helper: fire an authed /v1/responses turn, echo only the HTTP code ------
turn() { # turn -> prints "<code>|<observable-tail>"
  local body; body="$(jq -n '{model:"gpt-4.1-mini", input:"QA G-lane ping", stream:false}')"
  curl -s -o /dev/null -w '%{http_code}' -X POST "$RESP" \
    -H "authorization: Bearer $jwt" \
    -H "x-openclaw-clerk-session-id: $sid" \
    -H "x-openclaw-channel: $QA_CHANNEL" \
    -H "x-openclaw-device-id: $QA_DEVICE" \
    -H 'content-type: application/json' -d "$body" --max-time 30
}

# ---- 5. [G1] authed turn is accepted + auto-binds ---------------------------
say "5. [G1] authed turn -> ACCEPTED + auto-bind"
code="$(turn)"
if [ "$code" = "200" ]; then ok "authed /v1/responses -> 200 (verified-Clerk turn accepted)"
else bad "expected 200, got $code (if 401: check the gateway boot log — INACTIVE/ACTIVE, and that OPENCLAW_CLERK_* match curious-gobbler-86)"; fi

if [ -n "$DB_URL" ] && command -v psql >/dev/null 2>&1; then
  rows="$(psql "$DB_URL" -tAc "SELECT count(*) FROM lp_user_channels WHERE channel='$QA_CHANNEL' AND channel_peer_id='$QA_DEVICE';" 2>/dev/null)"
  [ "${rows:-0}" -ge 1 ] && ok "lp_user_channels bind row present (channel=$QA_CHANNEL peer=$QA_DEVICE)" \
                         || bad "no lp_user_channels row for ($QA_CHANNEL,$QA_DEVICE) — auto-bind did not persist"
else
  note "DB_URL unset (or no psql) — bind row not directly asserted. The 200 is the auto-bind signal; set DB_URL=<staging Postgres> to assert the lp_user_channels row."
fi

# ---- 6. [G2b] consent-kill: revoke the session, re-fire the SAME token -> 401
say "6. [G2b] consent-kill — revoke the Clerk session, re-use the SAME (still-valid) token"
rev="$(bapi POST "/v1/sessions/$sid/revoke")"
rstatus="$(printf '%s' "$rev" | jq -r '.status // empty')"
note "session revoke -> status=${rstatus:-?} (token ttl still ~${ttl}s, so a 401 now is REVOCATION, not expiry)"
sleep 2
code2="$(turn)"
if [ "$code2" = "401" ]; then
  ok "same token after sign-out -> 401 (CONSENT-KILL proven: revocation, token still crypto-valid)"
elif [ "$code2" = "200" ]; then
  bad "still 200 after revoke. If the gateway boot log says 'INACTIVE (no backend secret)', server-side revocation is OFF — set OPENCLAW_CLERK_SECRET_KEY on the gateway (Phase A2) and re-run; then this flips to 401."
else
  bad "expected 401, got $code2"
fi

# ---- summary ---------------------------------------------------------------
say "SUMMARY"
printf '  PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
note "Interpretation: PASS on step 5 = [G1] verified-Clerk auth + auto-bind live. PASS on step 6 = [G2b] consent-kill live (requires the gateway's OPENCLAW_CLERK_SECRET_KEY set = revocation ACTIVE). A 200-on-revoke with revocation INACTIVE is EXPECTED pre-A2, not a control failure."
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
