#!/usr/bin/env bash
# Syntropy NemoClaw Deployment Bootstrap
#
# Stages configuration artifacts, runs nemoclaw onboard with Syntropy
# presets, copies proprietary extensions into the sandbox, and validates
# the deployment.
#
# Usage:
#   ./deploy-syntropy.sh                     # Full deploy (onboard + extensions)
#   ./deploy-syntropy.sh --stage-only        # Copy config only, skip onboard
#   ./deploy-syntropy.sh --validate-only     # Run validation checks only
#
# Prerequisites:
#   - nemoclaw CLI installed (npm install -g nemoclaw)
#   - openshell runtime installed
#   - Kernel 6.1+ for Landlock support (recommended)
#   - SYNTROPY_API_BASE_URL set to the https base URL of the Syntropy API.
#     It has no default; staging refuses to run without it.
#
# Copyright (c) 2026 Syntropy Health Inc. All rights reserved.
# Proprietary and confidential.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NEMOCLAW_CONFIG_DIR="$SCRIPT_DIR/.."
SANDBOX_NAME="${SANDBOX_NAME:-shrine-openclaw}"
INFERENCE_PROVIDER="${INFERENCE_PROVIDER:-anthropic}"
NEMOCLAW_HOME_DIR="${NEMOCLAW_HOME:-$HOME/.nemoclaw}"
RENDER="$SCRIPT_DIR/render-endpoints.sh"
# Rendered copies deploy() applies. They exist only after stage_config.
STAGED_CONFIG="$NEMOCLAW_HOME_DIR/config/openclaw.json"
STAGED_POLICY="$NEMOCLAW_HOME_DIR/policies/syntropy-sandbox.yaml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Prerequisites ──────────────────────────────────────────────

check_prerequisites() {
  log_info "Checking prerequisites..."

  if ! command -v nemoclaw &>/dev/null; then
    log_error "nemoclaw CLI not found. Install: npm install -g nemoclaw"
    return 1
  fi
  log_info "  nemoclaw: $(nemoclaw --version 2>/dev/null || echo 'installed')"

  if ! command -v openshell &>/dev/null; then
    log_warn "openshell not found — nemoclaw onboard will install it"
  fi

  # Check kernel version for Landlock
  local kernel_version
  kernel_version=$(uname -r | cut -d. -f1-2)
  local kernel_major kernel_minor
  kernel_major=$(echo "$kernel_version" | cut -d. -f1)
  kernel_minor=$(echo "$kernel_version" | cut -d. -f2)

  if [[ "$kernel_major" -lt 6 ]] || { [[ "$kernel_major" -eq 6 ]] && [[ "$kernel_minor" -lt 1 ]]; }; then
    log_warn "Kernel $kernel_version detected. Landlock LSM requires 6.1+."
    log_warn "Sandbox will use best_effort compatibility mode."
  else
    log_info "  kernel: $kernel_version (Landlock supported)"
  fi

  # Check disk space (need >= 5GB)
  local avail_gb
  avail_gb=$(df -BG / | tail -1 | awk '{print $4}' | tr -d 'G')
  if [[ "$avail_gb" -lt 5 ]]; then
    log_warn "Low disk space: ${avail_gb}GB available (5GB recommended)"
  fi

  log_info "Prerequisites OK"
}

# ── Stage Config Artifacts ─────────────────────────────────────

# Every artifact goes through render-endpoints.sh, which takes the Syntropy
# API endpoint from the required SYNTROPY_API_BASE_URL and refuses (naming
# the setting) when it is unset, empty or not https://<DNS name>. Nothing is
# staged with a default host.
stage_config() {
  log_info "Staging Syntropy config artifacts..."

  local nemoclaw_home="$NEMOCLAW_HOME_DIR"
  local f

  # deploy() applies whatever is staged, so clear the previous run's copies
  # first: a stale policy or config must never pair with a new deployment.
  rm -f "$STAGED_POLICY" "$STAGED_CONFIG"

  # Render presets
  local presets_dir="$nemoclaw_home/blueprint/policies/presets"
  mkdir -p "$presets_dir"
  for f in "$NEMOCLAW_CONFIG_DIR/presets/"*.yaml; do
    "$RENDER" "$f" "$presets_dir/$(basename "$f")"
  done
  log_info "  Presets: syntropy, zep, whatsapp, postgresql"

  # Render agent manifest
  local agent_dir="$nemoclaw_home/agents/syntropy-openclaw"
  mkdir -p "$agent_dir"
  "$RENDER" "$NEMOCLAW_CONFIG_DIR/agents/syntropy-openclaw/manifest.yaml" "$agent_dir/manifest.yaml"
  log_info "  Agent manifest: syntropy-openclaw"

  # Render combined policy
  mkdir -p "$(dirname "$STAGED_POLICY")"
  if [[ -f "$NEMOCLAW_CONFIG_DIR/policies/syntropy-sandbox.yaml" ]]; then
    "$RENDER" "$NEMOCLAW_CONFIG_DIR/policies/syntropy-sandbox.yaml" "$STAGED_POLICY"
    log_info "  Combined policy: syntropy-sandbox.yaml"
  fi

  # Render sandbox openclaw.json
  mkdir -p "$(dirname "$STAGED_CONFIG")"
  "$RENDER" "$NEMOCLAW_CONFIG_DIR/config/openclaw.json" "$STAGED_CONFIG"
  log_info "  Sandbox config: openclaw.json"

  log_info "Config staged to $nemoclaw_home"
}

# ── Deploy (Onboard + Extensions) ─────────────────────────────

deploy() {
  log_info "Running NemoClaw onboard..."

  nemoclaw onboard \
    --agent syntropy-openclaw \
    --inference-provider "$INFERENCE_PROVIDER" \
    --sandbox-name "$SANDBOX_NAME"

  log_info "Onboard complete. Installing extensions..."

  # Copy proprietary extensions into sandbox writable dir
  local extensions=(
    persist-user-identity
    auth-memory-gate
    memory-graphiti
    catch-phrases
    syntropy
  )

  for ext in "${extensions[@]}"; do
    local ext_path="$REPO_DIR/extensions/$ext"
    if [[ -d "$ext_path" ]]; then
      openshell sandbox cp \
        "$ext_path" \
        "$SANDBOX_NAME:/sandbox/.openclaw-data/extensions/$ext"
      log_info "  Installed: $ext"
    else
      log_warn "  Extension not found: $ext_path"
    fi
  done

  # Copy sandbox-adapted openclaw.json
  # NOTE: /sandbox/.openclaw is read-only under Landlock. The config must
  # be staged BEFORE the sandbox arms its filesystem policy. We use
  # openshell sandbox cp with --pre-start which copies into the image
  # layer before Landlock is applied. If --pre-start is not available,
  # fall back to shields-down copy.
  # Deploy the rendered copy, never the repo file (which carries only
  # placeholders for the service endpoint).
  [[ -f "$STAGED_CONFIG" ]] || {
    log_error "Rendered config missing ($STAGED_CONFIG); stage_config must run first"
    return 1
  }
  if openshell sandbox cp --help 2>&1 | grep -q "pre-start"; then
    openshell sandbox cp --pre-start \
      "$STAGED_CONFIG" \
      "$SANDBOX_NAME:/sandbox/.openclaw/openclaw.json"
  else
    log_warn "  --pre-start not available; using shields-down copy"
    openshell shields down "$SANDBOX_NAME" --reason "staging openclaw.json" --timeout 30
    openshell sandbox cp \
      "$STAGED_CONFIG" \
      "$SANDBOX_NAME:/sandbox/.openclaw/openclaw.json"
    openshell shields up "$SANDBOX_NAME"
  fi
  log_info "  Config: openclaw.json"

  # Apply the rendered combined policy if staged
  if [[ -f "$STAGED_POLICY" ]]; then
    openshell policy set \
      --policy "$STAGED_POLICY" \
      "$SANDBOX_NAME"
    log_info "  Policy: syntropy-sandbox.yaml applied"
  fi

  log_info "Deployment complete"
}

# ── Validate ───────────────────────────────────────────────────

validate() {
  log_info "Running validation checks..."
  local failures=0

  # Health probe
  if curl -sf "http://localhost:18789/" >/dev/null 2>&1; then
    log_info "  Health probe: OK"
  else
    log_error "  Health probe: FAILED (http://localhost:18789/)"
    ((failures++))
  fi

  # Sandbox status
  if nemoclaw status 2>/dev/null | grep -q "$SANDBOX_NAME"; then
    log_info "  Sandbox status: running"
  else
    log_warn "  Sandbox status: not running or not detectable"
  fi

  # Plugin list (requires gateway to be up)
  if curl -sf "http://localhost:18789/" >/dev/null 2>&1; then
    log_info "  Gateway responding — check plugins manually with: openclaw plugins list"
  fi

  if [[ "$failures" -gt 0 ]]; then
    log_error "$failures validation check(s) failed"
    return 1
  fi

  log_info "Validation passed"
}

# ── Main ───────────────────────────────────────────────────────

main() {
  local mode="${1:-full}"

  case "$mode" in
    --stage-only)
      check_prerequisites
      stage_config
      ;;
    --validate-only)
      validate
      ;;
    --help|-h)
      echo "Usage: $0 [--stage-only|--validate-only|--help]"
      echo ""
      echo "  (no args)        Full deploy: stage + onboard + extensions + validate"
      echo "  --stage-only     Copy config artifacts only, skip onboard"
      echo "  --validate-only  Run validation checks only"
      echo ""
      echo "Environment variables:"
      echo "  SYNTROPY_API_BASE_URL https base URL of the Syntropy API (required, no default)"
      echo "  SANDBOX_NAME          Sandbox name (default: shrine-openclaw)"
      echo "  INFERENCE_PROVIDER    Inference provider (default: anthropic)"
      echo "  NEMOCLAW_HOME         NemoClaw home directory (default: ~/.nemoclaw)"
      ;;
    *)
      check_prerequisites
      stage_config
      deploy
      validate
      ;;
  esac
}

main "$@"
