#!/usr/bin/env bash
# Render the Syntropy service endpoint into a NemoClaw config artifact.
#
# Usage:
#   SYNTROPY_API_BASE_URL=https://<host> render-endpoints.sh <src> <dest>
#
# The service endpoint has no default. SYNTROPY_API_BASE_URL is required:
# unset, empty, or anything but https://<DNS name> (optionally :443, no path)
# → exit 1, naming the setting, and <dest> is not written. On success every
# placeholder in <src> is replaced:
#   __SYNTROPY_API_HOST__     → the host of SYNTROPY_API_BASE_URL
#   ${SYNTROPY_API_BASE_URL}  → the base URL (trailing slashes removed)
# A placeholder left unresolved after rendering is an error.
#
# Copyright (c) 2026 Syntropy Health Inc. All rights reserved.
# Proprietary and confidential.

set -euo pipefail

SETTING="SYNTROPY_API_BASE_URL"
HOST_TOKEN="__SYNTROPY_API_HOST__"
BASE_TOKEN='${SYNTROPY_API_BASE_URL}'

die() {
  echo "render-endpoints: $*" >&2
  exit 1
}

[[ $# -eq 2 ]] || die "usage: $SETTING=https://<host> $0 <src> <dest>"
src="$1"
dest="$2"
[[ -f "$src" ]] || die "source not found: $src"
# mv onto a directory would move the file inside it and still succeed.
[[ ! -d "$dest" ]] || die "destination is a directory: $dest"

base="${SYNTROPY_API_BASE_URL:-}"
[[ -n "$base" ]] || die "$SETTING is required (no default); set it to the https base URL of the Syntropy API"

# Strip trailing slashes so "<base>/api/..." never doubles up.
while [[ "$base" == */ ]]; do
  base="${base%/}"
done

# No path: the egress policy allows the service's root paths only, so a
# path-prefixed base would render cleanly and then be blocked at the sandbox
# boundary. The value is limited to plain URL characters, so the literal
# replacement below behaves the same on every bash (5.2+ treats & specially).
[[ "$base" =~ ^https://([A-Za-z0-9.-]+)(:[0-9]+)?$ ]] ||
  die "$SETTING must be https://<host> with no path, query or credentials (got a value of length ${#base})"
host="${BASH_REMATCH[1]}"
port="${BASH_REMATCH[2]}"

# The egress policy and preset allow port 443 only, so any other port would
# be blocked at the sandbox boundary. Refuse it here instead.
[[ -z "$port" || "$port" == ":443" ]] ||
  die "$SETTING must use the default https port (443); the sandbox egress policy allows no other"

# A fully qualified DNS name: two or more labels, each 1-63 chars of
# letters, digits and inner hyphens.
label='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
[[ "$host" =~ ^($label\.)+$label$ ]] ||
  die "$SETTING host must be a fully qualified DNS name"
# URL parsers read all-digit (decimal/octal) and 0x-prefixed (hex) labels as
# parts of an IP address, so any such label is refused: no IP literal in any
# notation can reach the egress allowlist.
IFS='.' read -r -a labels <<<"$host"
for l in "${labels[@]}"; do
  if [[ "$l" =~ ^[0-9]+$ || "$l" =~ ^0[xX][0-9A-Fa-f]*$ ]]; then
    die "$SETTING host must be a DNS name, not an IP address in any notation"
  fi
done

# Literal (non-regex) replacement, so no character in the value is special.
rendered="$(<"$src")"
rendered="${rendered//"$HOST_TOKEN"/$host}"
rendered="${rendered//"$BASE_TOKEN"/$base}"

if [[ "$rendered" == *"$HOST_TOKEN"* || "$rendered" == *"$BASE_TOKEN"* ]]; then
  die "unresolved placeholder left in $src"
fi

tmp="$(mktemp "${dest}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$rendered" >"$tmp"
# mktemp creates 0600; staged artifacts must stay readable like the old cp.
chmod 0644 "$tmp"
mv "$tmp" "$dest"
trap - EXIT
[[ -f "$dest" ]] || die "rendered file missing after move: $dest"
