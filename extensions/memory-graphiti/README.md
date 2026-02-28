# @openclaw/memory-graphiti

Graph-based knowledge memory plugin for OpenClaw using [Graphiti](https://github.com/getzep/graphiti) — a temporally-aware knowledge graph framework.

Supports two backends:

- **Zep Cloud** (managed) — uses `@getzep/zep-cloud` SDK with API key
- **Self-hosted Graphiti** — raw REST API calls to a user-managed Graphiti server

## Quick Start: Zep Cloud (Recommended)

1. Get an API key at [app.getzep.com](https://app.getzep.com)
2. Set the environment variable:
   ```bash
   export GETZEP_API_KEY=z_your_key_here
   ```
3. Configure the plugin:
   ```json
   {
     "plugins": {
       "slots": { "memory": "memory-graphiti" },
       "config": {
         "memory-graphiti": {
           "apiKey": "${GETZEP_API_KEY}"
         }
       }
     }
   }
   ```

That's it. Zep Cloud handles Neo4j, entity extraction, and LLM processing.

## Quick Start: Self-Hosted Graphiti

### Prerequisites

A running Graphiti REST API server backed by Neo4j:

```bash
git clone https://github.com/getzep/graphiti.git
cd graphiti
cp .env.example .env
# Set OPENAI_API_KEY (required for entity extraction)
docker compose up -d
```

Verify: `curl http://localhost:8000/healthcheck`

### Configuration

```json
{
  "plugins": {
    "slots": { "memory": "memory-graphiti" },
    "config": {
      "memory-graphiti": {
        "serverUrl": "${GRAPHITI_SERVER_URL}"
      }
    }
  }
}
```

## Configuration Reference

| Option            | Type                                            | Default            | Description                                                          |
| ----------------- | ----------------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| `apiKey`          | string                                          | —                  | Zep Cloud API key. When set, uses Zep Cloud backend.                 |
| `serverUrl`       | string                                          | —                  | Self-hosted Graphiti REST API URL. Used when apiKey is not set.      |
| `userId`          | string                                          | —                  | Fixed Zep Cloud user ID. If not set, derived from group ID strategy. |
| `groupIdStrategy` | `"channel-sender"` \| `"session"` \| `"static"` | `"channel-sender"` | How to partition the knowledge graph.                                |
| `staticGroupId`   | string                                          | —                  | Required when strategy is `"static"`.                                |
| `autoCapture`     | boolean                                         | `true`             | Capture conversations after each agent turn.                         |
| `autoRecall`      | boolean                                         | `true`             | Inject relevant facts before each agent turn.                        |
| `maxFacts`        | number (1–100)                                  | `10`               | Max facts to inject during auto-recall.                              |

**Backend auto-detection**: If `apiKey` is set → Zep Cloud. Otherwise → self-hosted Graphiti REST API.

All string config values support `${ENV_VAR}` syntax for environment variable resolution.

### Group ID Strategies

- **`channel-sender`** (default): Partitions by `{provider}:{senderId}`. Each user gets their own knowledge graph per messaging channel.
- **`session`**: Uses the full session key. Each conversation thread gets its own graph.
- **`static`**: All conversations share a single graph identified by `staticGroupId`.

In Zep Cloud mode, the group ID maps to a Zep Cloud `userId`. Users are auto-created on first interaction.

## How It Works

### Auto-Capture (`agent_end` hook)

After each agent turn, the plugin extracts user and assistant messages and sends them to the knowledge graph. The backend asynchronously processes them — extracting entities, relationships, and temporal facts.

### Auto-Recall (`before_agent_start` hook)

Before each agent turn, the plugin searches the knowledge graph for facts relevant to the user's prompt and injects them as context via `prependContext`.

### Agent Tools

- **`graphiti_search`** — Search the knowledge graph for facts by natural language query.
- **`graphiti_episodes`** — Retrieve recent conversation episodes stored in the graph.

### CLI

```bash
openclaw graphiti status   # Check server/API connectivity
```

## Development

```bash
# Unit tests
pnpm vitest run extensions/memory-graphiti/index.test.ts

# Integration tests (requires GETZEP_API_KEY)
GETZEP_API_KEY=<key> pnpm vitest run extensions/memory-graphiti/integration.test.ts
```
