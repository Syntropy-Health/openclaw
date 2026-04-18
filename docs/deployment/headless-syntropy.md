# Headless Syntropy Deployment

Deploy OpenClaw as a headless multi-channel chat gateway for Syntropy Health.

## Required Plugins

| Plugin                  | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `persist-user-identity` | User registration, `!verify` command, identity storage |
| `persist-postgres`      | Message persistence                                    |
| `auth-memory-gate`      | Identity hard gate, `[MEMORY_SCOPE]` injection         |
| `syntropy`              | Health tools, token storage, `[SYNTROPY_GATE]`         |
| `memory-graphiti`       | Scoped conversation memory                             |

## Required Channels

At minimum one channel must be enabled:

| Channel      | Config Key               |
| ------------ | ------------------------ |
| WhatsApp     | `channels.whatsapp`      |
| Slack        | `channels.slack`         |
| SMS (Twilio) | `channels.sms` (Phase 5) |

## Environment Variables

| Variable                 | Required    | Description                                          |
| ------------------------ | ----------- | ---------------------------------------------------- |
| `DATABASE_URL`           | Yes         | PostgreSQL connection string (shared by all plugins) |
| `NODE_ENV`               | Yes         | `production`                                         |
| `OPENCLAW_GATEWAY_TOKEN` | Yes         | Gateway auth token                                   |
| LLM API key              | Yes         | Provider-specific (e.g., `ANTHROPIC_API_KEY`)        |
| Channel tokens           | Per channel | `SLACK_BOT_TOKEN`, WhatsApp credentials, etc.        |

**No `OPENCLAW_SERVICE_KEY` needed** — auth is per-user via Syntropy ApiTokens.

## Minimal `openclaw.json`

```json
{
  "channels": {
    "enabled": ["whatsapp"]
  },
  "plugins": {
    "enabled": true,
    "allow": [
      "persist-user-identity",
      "persist-postgres",
      "auth-memory-gate",
      "syntropy",
      "memory-graphiti"
    ],
    "entries": {
      "persist-user-identity": {
        "enabled": true,
        "config": {
          "auth": {
            "mode": "passcode-endpoint",
            "passcodeVerifyUrl": "https://api.syntropyhealth.com/api/ext/pairing/verify",
            "userLookupUrl": "https://api.syntropyhealth.com/api/ext/users/search",
            "apiToken": ""
          }
        }
      },
      "persist-postgres": { "enabled": true, "config": {} },
      "auth-memory-gate": {
        "enabled": true,
        "config": { "hardGate": true, "requireVerified": false }
      },
      "syntropy": {
        "enabled": true,
        "config": { "syntropyBaseUrl": "https://api.syntropyhealth.com" }
      },
      "memory-graphiti": {
        "enabled": true,
        "config": {
          "groupIdStrategy": "identity",
          "autoCapture": true,
          "autoRecall": true,
          "maxFacts": 10
        }
      }
    },
    "slots": { "memory": "memory-graphiti" }
  }
}
```

## Pairing Flow

1. User logs into Syntropy web UI
2. Clicks "Link Device" → sees 6-digit code (10-min TTL)
3. Opens WhatsApp/Slack → types `!verify 482951`
4. OpenClaw calls `POST /api/ext/pairing/verify`
5. Syntropy validates code, issues `ApiToken`, returns `auth_token`
6. OpenClaw stores token in `syntropy_tokens` table
7. User now has full access to 9 health tools via chat

## Database Tables (Auto-Created)

| Table              | Created By            | Purpose                    |
| ------------------ | --------------------- | -------------------------- |
| `lp_users`         | persist-user-identity | Canonical user identity    |
| `lp_user_channels` | persist-user-identity | Channel → user mapping     |
| `lp_conversations` | persist-postgres      | Conversation metadata      |
| `lp_messages`      | persist-postgres      | Message history            |
| `syntropy_tokens`  | syntropy              | Stored API tokens per user |

## Fly.io Deployment

```bash
fly deploy --config fly.toml
fly secrets set DATABASE_URL="postgresql://..." ANTHROPIC_API_KEY="..."
```

The `fly.toml` in the repo root configures:

- App: `shrine-openclaw`
- Region: `iad`
- VM: `shared-cpu-2x`, 2048MB RAM
- Persistent volume: `/data`

## NemoClaw Deployment (Sandbox Mode)

For production deployments requiring security hardening, run the gateway inside a [NemoClaw](https://github.com/NVIDIA/NemoClaw) sandbox. This adds:

- **Filesystem isolation** (Landlock LSM) — agent can only write to `/sandbox/.openclaw-data`
- **Network egress control** (deny-by-default L7 proxy) — only approved endpoints reachable
- **Credential isolation** — secrets stay on host, never enter the sandbox
- **Secret scanning** — blocks credential leakage into agent memory writes

### Prerequisites

- NemoClaw CLI: `npm install -g nemoclaw`
- OpenShell runtime (installed during `nemoclaw onboard`)
- Linux kernel 6.1+ for full Landlock support (best_effort fallback available)
- 5GB disk, 2GB RAM minimum

### Quick Start

```bash
cd nemoclaw/
./scripts/deploy-syntropy.sh
```

Or step by step:

```bash
# 1. Stage config artifacts
./scripts/deploy-syntropy.sh --stage-only

# 2. Onboard with Syntropy agent
nemoclaw onboard --agent syntropy-openclaw --inference-provider anthropic

# 3. Apply combined network policy
openshell policy set --policy nemoclaw/policies/syntropy-sandbox.yaml shrine-openclaw

# 4. Validate
./scripts/deploy-syntropy.sh --validate-only
```

### Network Policies

The combined policy (`nemoclaw/policies/syntropy-sandbox.yaml`) allows egress to:

| Endpoint                  | Protocol         | Purpose                          |
| ------------------------- | ---------------- | -------------------------------- |
| `api.syntropyhealth.com`  | REST             | MCP health tools, pairing verify |
| `api.getzep.com`          | REST             | Graph memory (Zep Cloud)         |
| `web.whatsapp.com`        | WebSocket        | WhatsApp message transport       |
| `monorail.proxy.rlwy.net` | TCP              | PostgreSQL database              |
| `*.slack.com`             | REST + WebSocket | Slack API + Socket Mode          |
| `api.anthropic.com`       | REST             | Inference (Anthropic)            |

All other egress is blocked. See `nemoclaw/README.md` for full details.

### Credential Management

Credentials are stored on the host at `~/.nemoclaw/credentials.json` and injected into the gateway process by OpenShell. They never appear inside the sandbox filesystem.

### Troubleshooting

| Issue                            | Solution                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Gateway can't reach Syntropy API | Check `openshell policy get --full shrine-openclaw` for `syntropy_api` entry         |
| WhatsApp WebSocket drops         | Verify `web.whatsapp.com` uses `access: full` (CONNECT tunnel), not `protocol: rest` |
| DB connection refused            | Confirm PostgreSQL host in policy matches `DATABASE_URL` hostname                    |
| "Landlock not available" warning | Kernel < 6.1 — runs in `best_effort` mode (functional but degraded isolation)        |
