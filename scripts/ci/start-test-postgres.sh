#!/usr/bin/env bash
# Start a throwaway Postgres 16 with TLS for the Postgres-backed integration tests, then print a DATABASE_URL.
#
# The integration suites (extensions/*/…integration.test.ts) skip when DATABASE_URL is unset, and they connect
# with TLS (`ssl: { rejectUnauthorized: false }`), so the server must have ssl=on. Everything here is disposable:
# a fresh self-signed certificate and a random password per run, a container named by $PG_CONTAINER, no volume.
#
# Usage: DATABASE_URL="$(scripts/ci/start-test-postgres.sh)"   (stdout carries ONLY the URL)
#   PG_CONTAINER (default openclaw-test-pg), PG_PORT (default 55432), PG_IMAGE (default postgres:16)
set -euo pipefail

name="${PG_CONTAINER:-openclaw-test-pg}"
port="${PG_PORT:-55432}"
image="${PG_IMAGE:-postgres:16}"
work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

password="$(openssl rand -hex 24)"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::${password}" >&2
fi

# stdout must carry only the URL. openssl's progress noise is kept out of the log, but shown if it fails.
if ! openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout "$work/server.key" -out "$work/server.crt" >/dev/null 2>"$work/openssl.err"; then
  echo "could not generate the test TLS certificate:" >&2
  cat "$work/openssl.err" >&2
  exit 1
fi

# The password goes in through an env FILE, never on the docker command line.
umask 077
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=openclaw_test\n' "$password" > "$work/pg.env"

docker rm -f "$name" >/dev/null 2>&1 || true
# Postgres refuses a key it does not own (or with group/world access), so the cert pair is copied in at start
# and chowned to the postgres user before the server reads it.
docker run -d --name "$name" -p "127.0.0.1:${port}:5432" --env-file "$work/pg.env" \
  -v "$work/server.crt:/tls-in/server.crt:ro" -v "$work/server.key:/tls-in/server.key:ro" \
  --entrypoint bash "$image" -c '
    set -e
    install -o postgres -g postgres -m 0644 /tls-in/server.crt /var/lib/postgresql/server.crt
    install -o postgres -g postgres -m 0600 /tls-in/server.key /var/lib/postgresql/server.key
    exec docker-entrypoint.sh postgres -c ssl=on \
      -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key
  ' >/dev/null

ready=""
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d openclaw_test >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "postgres did not become ready in 60 s" >&2
  docker logs "$name" 2>&1 | tail -20 >&2
  exit 1
fi
# The image's init runs a temporary server first, on the unix socket only; the TCP pg_isready above therefore
# only passes once the REAL server is up. Confirm TLS over the (trusted) local socket before handing out the URL.
for _ in $(seq 1 30); do
  ssl="$(docker exec "$name" psql -U postgres -d openclaw_test -tAc 'show ssl' 2>/dev/null || true)"
  [ "$ssl" = "on" ] && break
  sleep 1
done
if [ "${ssl:-}" != "on" ]; then
  echo "postgres is up but ssl is '${ssl:-unknown}', not on" >&2
  exit 1
fi

echo "postgresql://postgres:${password}@127.0.0.1:${port}/openclaw_test?sslmode=require"
