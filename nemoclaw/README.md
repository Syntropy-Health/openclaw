# NemoClaw Configuration — Syntropy Health

Configuration artifacts for deploying the Syntropy OpenClaw plugin stack inside a [NemoClaw](https://github.com/NVIDIA/NemoClaw) sandbox.

**No plugin code changes required** — these are purely operational configs (network policies, agent manifest, deployment script).

## Directory Structure

```
nemoclaw/
  agents/syntropy-openclaw/
    manifest.yaml          # Agent manifest (extends OpenClaw with WhatsApp + Syntropy)
  config/
    openclaw.json          # Sandbox-adapted OpenClaw config (production URLs)
  policies/
    syntropy-sandbox.yaml  # Pre-merged combined policy (base + all presets)
  presets/
    syntropy.yaml          # Network policy: Syntropy Health API
    zep.yaml               # Network policy: Zep Cloud (graph memory)
    whatsapp.yaml          # Network policy: WhatsApp Web (CONNECT tunnel)
    postgresql.yaml        # Network policy: PostgreSQL (raw TCP)
  scripts/
    deploy-syntropy.sh     # Deployment bootstrap script
```

## Quick Start

```bash
# Full deployment
./scripts/deploy-syntropy.sh

# Stage config only (no onboard)
./scripts/deploy-syntropy.sh --stage-only

# Validate existing deployment
./scripts/deploy-syntropy.sh --validate-only
```

## Network Policy Summary

| Policy         | Endpoint                       | Protocol     | Purpose                          |
| -------------- | ------------------------------ | ------------ | -------------------------------- |
| `syntropy_api` | `api.syntropyhealth.com:443`   | REST         | MCP health tools, pairing verify |
| `zep_cloud`    | `api.getzep.com:443`           | REST         | Graph memory backend             |
| `whatsapp`     | `web.whatsapp.com:443`         | CONNECT      | WebSocket message transport      |
| `whatsapp`     | `mmg.whatsapp.net:443`         | REST         | Media CDN                        |
| `postgresql`   | `monorail.proxy.rlwy.net:5432` | TCP          | Identity DB, tokens, messages    |
| `slack`        | `*.slack.com:443`              | REST+CONNECT | Slack API + Socket Mode          |

Plus base NemoClaw policies: Anthropic, NVIDIA, ClawHub, OpenClaw, npm, Telegram, Discord.

## Credential Management

Credentials are injected by OpenShell into the gateway process — they never appear inside the sandbox filesystem.

Required credentials (set on host):

- `DATABASE_URL` — PostgreSQL connection string
- `ZEP_API_KEY` — Zep Cloud API key (for memory-graphiti)
- `ANTHROPIC_API_KEY` — Inference provider (or NVIDIA key)
- `SLACK_BOT_TOKEN` — Slack bot token
- `SLACK_APP_TOKEN` — Slack app-level token (Socket Mode)
- `OPENCLAW_GATEWAY_TOKEN` — Gateway auth token

## Adding New Endpoints

1. Create a preset in `presets/<name>.yaml` following the existing format
2. Add the preset entries to `policies/syntropy-sandbox.yaml`
3. Re-apply: `openshell policy set --policy policies/syntropy-sandbox.yaml shrine-openclaw`

## Updating Extensions

```bash
# Copy updated extension into sandbox
openshell sandbox cp extensions/<name> shrine-openclaw:/sandbox/.openclaw-data/extensions/<name>

# Restart gateway to pick up changes
openshell sandbox restart shrine-openclaw
```

## Related Documentation

- [Headless Deployment Guide](../docs/deployment/headless-syntropy.md)
- [NemoClaw Developer Guide](https://docs.nvidia.com/nemoclaw/latest/)
- [OpenClaw Plugin Docs](https://docs.openclaw.ai/tools/plugin)
