#!/bin/bash
set -euo pipefail

# Railway entrypoint for OpenClaw gateway.
#
# Flow:
#   1. Generate gateway config with Cerebras as model provider (if none exists)
#   2. Start the gateway immediately (so health checks pass)
#   3. After gateway is listening, run WhatsApp QR login in the foreground
#      (QR code prints to stdout = visible in Railway logs)
#
# Required environment variables (set in Railway dashboard):
#   CEREBRAS_API_KEY        - Cerebras API key (csk-...)
#   OPENCLAW_GATEWAY_TOKEN  - Auth token for non-loopback binding
#
# Optional environment variables:
#   PORT                    - Railway-assigned port (default: 3000)
#   OPENCLAW_WA_AUTH_DIR    - Custom WhatsApp auth directory
#   OPENCLAW_SKIP_WA_LOGIN  - Set to "1" to skip the auto-login flow
#   OPENCLAW_MODEL_PRIMARY  - Override primary model (default: cerebras/zai-glm-4.7)
#   OPENCLAW_MODEL_FALLBACK - Override fallback model (default: cerebras/gpt-oss-120b)

PORT="${PORT:-3000}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
WA_AUTH_DIR="${OPENCLAW_WA_AUTH_DIR:-$STATE_DIR/sessions/whatsapp/auth_info}"
CONFIG_FILE="$STATE_DIR/openclaw.json"
PRIMARY_MODEL="${OPENCLAW_MODEL_PRIMARY:-cerebras/zai-glm-4.7}"
FALLBACK_MODEL="${OPENCLAW_MODEL_FALLBACK:-cerebras/gpt-oss-120b}"

echo "=== OpenClaw Railway Gateway ==="
echo "Port: $PORT"
echo "State dir: $STATE_DIR"
echo "Model: $PRIMARY_MODEL (fallback: $FALLBACK_MODEL)"

# Ensure state directories exist
mkdir -p "$STATE_DIR" "$WA_AUTH_DIR"

# Generate gateway config with Cerebras provider if none exists or missing required fields
if [ ! -f "$CONFIG_FILE" ] || ! grep -q '"allowFrom"' "$CONFIG_FILE" 2>/dev/null; then
  echo "Generating gateway config with Cerebras provider + WhatsApp channel..."
  cat > "$CONFIG_FILE" <<CONF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "$PRIMARY_MODEL",
        "fallbacks": ["$FALLBACK_MODEL"]
      }
    }
  },
  "channels": {
    "whatsapp": {
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  },
  "web": {
    "enabled": true,
    "heartbeatSeconds": 60
  },
  "gateway": {
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cerebras": {
        "baseUrl": "https://api.cerebras.ai/v1",
        "apiKey": "\${CEREBRAS_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "zai-glm-4.7", "name": "GLM 4.7 (Cerebras, 355B)" },
          { "id": "gpt-oss-120b", "name": "GPT-OSS 120B (Cerebras)" },
          { "id": "qwen-3-235b-a22b-instruct-2507", "name": "Qwen 3 235B (Cerebras)" },
          { "id": "llama3.1-8b", "name": "Llama 3.1 8B (Cerebras)" }
        ]
      }
    }
  }
}
CONF
  echo "Config written to $CONFIG_FILE"
else
  echo "Existing config found at $CONFIG_FILE"
fi

# Validate Cerebras API key is set
if [ -z "${CEREBRAS_API_KEY:-}" ]; then
  echo "WARNING: CEREBRAS_API_KEY is not set. Model calls will fail."
  echo "Set it in Railway dashboard: Settings > Variables > CEREBRAS_API_KEY"
fi

# Build auth args
AUTH_ARGS=()
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  AUTH_ARGS+=(--token "$OPENCLAW_GATEWAY_TOKEN")
elif [ -n "${OPENCLAW_GATEWAY_PASSWORD:-}" ]; then
  AUTH_ARGS+=(--password "$OPENCLAW_GATEWAY_PASSWORD")
else
  echo "WARNING: No OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD set."
  echo "Using --auth none (not recommended for production)."
  AUTH_ARGS+=(--auth none)
fi

# Check if WhatsApp credentials already exist
wa_creds_exist() {
  [ -f "$WA_AUTH_DIR/creds.json" ] && [ -s "$WA_AUTH_DIR/creds.json" ]
}

wa_needs_login=false
if wa_creds_exist; then
  echo "WhatsApp credentials found - will auto-connect on gateway start."
elif [ "${OPENCLAW_SKIP_WA_LOGIN:-0}" = "1" ]; then
  echo "OPENCLAW_SKIP_WA_LOGIN=1 - skipping WhatsApp login."
  echo "To connect WhatsApp later, restart with OPENCLAW_SKIP_WA_LOGIN unset."
else
  wa_needs_login=true
fi

echo "Starting gateway on 0.0.0.0:$PORT ..."

# Start gateway in background so health checks pass immediately
node openclaw.mjs gateway \
  --allow-unconfigured \
  --bind lan \
  --port "$PORT" \
  "${AUTH_ARGS[@]}" &
GATEWAY_PID=$!

# Wait for gateway to be ready
echo "Waiting for gateway to be ready..."
for i in $(seq 1 60); do
  if node -e "fetch('http://localhost:$PORT').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Gateway is ready (took ${i}s)."
    break
  fi
  sleep 1
done

# Run WhatsApp QR login after gateway is healthy
if [ "$wa_needs_login" = true ]; then
  echo ""
  echo "=========================================="
  echo "  WhatsApp QR Login"
  echo "=========================================="
  echo ""
  echo "No WhatsApp credentials found."
  echo "A QR code will appear below."
  echo "Scan it with WhatsApp:"
  echo "  Phone > Settings > Linked Devices > Link a Device"
  echo ""
  echo "Waiting for QR code from WhatsApp servers..."
  echo ""

  # Run login flow; QR prints to stdout (visible in Railway logs).
  # Timeout after 90s. Gateway is already running and healthy.
  if timeout 90 node openclaw.mjs channels login --channel whatsapp 2>&1; then
    echo ""
    echo "WhatsApp linked successfully! Restarting gateway to pick up creds..."
    # Restart gateway so it connects WhatsApp with the new creds
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
    exec node openclaw.mjs gateway \
      --allow-unconfigured \
      --bind lan \
      --port "$PORT" \
      "${AUTH_ARGS[@]}"
  else
    echo ""
    echo "WhatsApp login timed out or failed."
    echo "Gateway is running without WhatsApp."
    echo "To retry: restart the service with OPENCLAW_SKIP_WA_LOGIN unset."
  fi
fi

# Keep the entrypoint alive by waiting on the gateway process
wait "$GATEWAY_PID"
