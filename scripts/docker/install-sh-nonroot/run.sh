#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
DEFAULT_PACKAGE="openclaw"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}"

echo "==> Pre-flight: ensure git absent"
if command -v git >/dev/null; then
  echo "git is present unexpectedly" >&2
  exit 1
fi

echo "==> Run installer (non-root user)"
curl -fsSL "$INSTALL_URL" | bash

# Ensure PATH picks up user npm prefix
export PATH="$HOME/.npm-global/bin:$PATH"

echo "==> Verify git installed"
command -v git >/dev/null

EXPECTED_VERSION="${OPENCLAW_INSTALL_EXPECT_VERSION:-}"
if [[ -n "$EXPECTED_VERSION" ]]; then
  LATEST_VERSION="$EXPECTED_VERSION"
else
  LATEST_VERSION="$(npm view "$PACKAGE_NAME" version)"
fi
CLI_NAME="$PACKAGE_NAME"
CMD_PATH="$(command -v "$CLI_NAME" || true)"
if [[ -z "$CMD_PATH" && -x "$HOME/.npm-global/bin/$PACKAGE_NAME" ]]; then
  CLI_NAME="$PACKAGE_NAME"
  CMD_PATH="$HOME/.npm-global/bin/$PACKAGE_NAME"
fi
if [[ -z "$CMD_PATH" ]]; then
  echo "$PACKAGE_NAME is not on PATH" >&2
  exit 1
fi
echo "==> Verify CLI installed: $CLI_NAME"
# `--version` may print a bare version ("2026.6.11") OR a banner-style line
# ("OpenClaw 2026.7.1 (2d2ddc4)") — parse the semver token so the assertion is
# robust to the banner format (mirrors install-sh-smoke/run.sh; #58 fixed the
# root harness but missed this sibling nonroot one).
RAW_VERSION_OUTPUT="$("$CMD_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
INSTALLED_VERSION="$(printf '%s' "$RAW_VERSION_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?' | head -n 1)"

echo "cli=$CLI_NAME installed=$INSTALLED_VERSION expected=$LATEST_VERSION raw=$RAW_VERSION_OUTPUT"
if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]]; then
  echo "ERROR: expected ${CLI_NAME}@${LATEST_VERSION}, got ${CLI_NAME}@${INSTALLED_VERSION:-<unparsed>} (raw: $RAW_VERSION_OUTPUT)" >&2
  exit 1
fi

echo "==> Sanity: CLI runs"
"$CMD_PATH" --help >/dev/null

echo "OK"
