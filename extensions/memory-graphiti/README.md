# @openclaw/memory-graphiti

Graph-based knowledge memory plugin for OpenClaw using [Graphiti](https://github.com/getzep/graphiti) — a temporally-aware knowledge graph framework.

Two backends, selected **explicitly** via `backend`:

- **Self-hosted Graphiti** (`backend: "self-hosted"`, the **default**) — raw REST API to a server you run. **This is the production posture for real-user PHI** (data stays in-house).
- **Zep Cloud** (`backend: "zep-cloud"`) — managed (`@getzep/zep-cloud`). **QA / synthetic ONLY**, behind the PHI tripwire (see below).

> ⚠️ **PHI posture (locked).** Real-user health conversations are PHI. Self-hosted is the production target; Zep Cloud is permitted for QA/synthetic data only and is guarded by a fail-closed per-sender tripwire. **No real user gets memory until the self-hosted backend ships** and the tripwire verifies the QA→prod swap (the RELEASE RULE). See [`workstreams/openclaw/design/memory-model-contract.md`](../../../../workstreams/openclaw/design/memory-model-contract.md) for the cross-service contract (openclaw ⇄ syntropy-journals share ONE user graph).

## Quick Start: Self-Hosted (production posture)

### Prerequisites

A running Graphiti REST API server backed by Neo4j:

```bash
git clone https://github.com/getzep/graphiti.git
cd graphiti && cp .env.example .env
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
        "backend": "self-hosted",
        "serverUrl": "${GRAPHITI_SERVER_URL}",
        "groupIdStrategy": "identity"
      }
    }
  }
}
```

## Quick Start: Zep Cloud (QA / synthetic ONLY)

Permitted only for QA with a **synthetic allow-list**. You MUST set `qaNumbers` (the known-synthetic E.164 numbers) — the tripwire refuses every Zep touch whose resolved sender is not in this set, and **fails closed** if it is empty/absent.

```json
{
  "plugins": {
    "slots": { "memory": "memory-graphiti" },
    "config": {
      "memory-graphiti": {
        "backend": "zep-cloud",
        "apiKey": "${GETZEP_API_KEY}",
        "qaNumbers": ["+14155550123", "+14155550124"],
        "groupIdStrategy": "identity"
      }
    }
  }
}
```

QA→prod is a **config swap**, not a redesign: flip `backend` to `self-hosted` + point `serverUrl` at the in-house instance.

## PHI Tripwire (the safety control)

Enforced at the point of PHI flow (capture, recall, and every `memory_*`/`graphiti_*` tool):

- **Per-sender gate (load-bearing):** Zep is touched ONLY when the conversation's host-resolved E.164 sender (`ctx.senderE164`) is in `qaNumbers`. Any other sender — real user, group, other channel, paired peer — is dropped. **Fail-closed:** null/non-QA sender or empty `qaNumbers` ⇒ drop. Capture silent-drops, recall returns empty, tools refuse; never throws into the reply.
- **Registration gate (defense-in-depth):** selecting `zep-cloud` while the live WhatsApp DM allow-list is not provably QA-only **hard-fails plugin load**.
- **Self-hosted is NEVER gated** — PHI in-house is the sanctioned path.
- **Observability:** a refusal emits a stable `phi_tripwire_breach` error marker (op + reason only — never the sender PII). Wire log-based alerting / a metric on that token.

> The `memory_*`/`graphiti_*` **tools** carry no per-call sender context (the SDK `execute` signature), so they **fail closed on cloud** (refused) and work only on self-hosted. The auto-capture/recall **hooks** do have `ctx.senderE164` and are gated precisely.

## Configuration Reference

| Option            | Type                                                            | Default            | Description                                                                                                               |
| ----------------- | --------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `backend`         | `"self-hosted"` \| `"zep-cloud"`                                | `"self-hosted"`    | **Explicit** backend selection. Self-hosted = prod posture.                                                               |
| `qaNumbers`       | string[] (E.164)                                                | `[]`               | Known-synthetic QA senders. **Required for `zep-cloud`**; validated E.164 at parse; the tripwire fails closed when empty. |
| `serverUrl`       | string                                                          | —                  | Self-hosted Graphiti REST URL. Required for `self-hosted`.                                                                |
| `apiKey`          | string                                                          | —                  | Zep Cloud API key. Required for `zep-cloud`.                                                                              |
| `userId`          | string                                                          | —                  | Fixed Zep user ID. If unset, derived from the group-id strategy.                                                          |
| `groupIdStrategy` | `"channel-sender"` \| `"session"` \| `"static"` \| `"identity"` | `"channel-sender"` | How to partition the graph. `"identity"` recommended (see below).                                                         |
| `staticGroupId`   | string                                                          | —                  | Required when strategy is `"static"`.                                                                                     |
| `databaseUrl`     | string                                                          | —                  | PostgreSQL URL for `"identity"` strategy. Falls back to `DATABASE_URL`.                                                   |
| `autoCapture`     | boolean                                                         | `true`             | Capture conversations after each agent turn.                                                                              |
| `autoRecall`      | boolean                                                         | `true`             | Inject relevant facts before each agent turn.                                                                             |
| `maxFacts`        | number (1–100)                                                  | `10`               | Max facts to inject during auto-recall.                                                                                   |

> **Deprecated:** omitting `backend` and relying on `apiKey`-presence auto-detection still works but logs a deprecation warning — always set `backend` explicitly.

All string config values support `${ENV_VAR}` syntax.

## Memory scope model (per-user ⊇ per-device ⊇ per-session)

The graph is **partitioned by `user_scope`** (the Graphiti `group_id`), with device + session as episode metadata:

| Level       | Key                           | Role                                                                                    |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| **User**    | `external_id ?? user_id`      | the partition / `group_id` — one persistent graph per person, across devices + sessions |
| **Device**  | `{channel}:{channel_peer_id}` | episode metadata (e.g. `whatsapp:+1415…`)                                               |
| **Session** | `session_id`                  | episode metadata — a session lives on one device                                        |

`user_scope` is the single source of truth — `deriveScopeKey()` in [`extensions/shared/scope-key.ts`](../shared/scope-key.ts), shared with `auth-memory-gate` (the `[MEMORY_SCOPE].scope_key`). The `external_id`-vs-`user_id` precedence is the one line that reconciles with Syntropy-Journals #9–#11. The full cross-service contract (so SJ's Python backend writes to the **same** graph) is [`memory-model-contract.md`](../../../../workstreams/openclaw/design/memory-model-contract.md).

### Group ID Strategies

- **`identity`** (recommended): canonical `user_scope` from the `persist-user-identity` DB — verified users share one graph across channels.
- **`channel-sender`** (default): `{provider}:{senderId}` — per-channel, no cross-channel continuity.
- **`session`**: per-conversation graph. **`static`**: one shared graph (`staticGroupId`).

### Required plugins for `identity` (priority order)

| Plugin                  | Priority | Role                              |
| ----------------------- | -------- | --------------------------------- |
| `persist-user-identity` | 60       | Resolves user from channel + peer |
| `persist-postgres`      | 50       | Persists messages                 |
| `auth-memory-gate`      | 40       | Derives `scope_key`, gates access |
| `memory-graphiti`       | 0        | Recalls/captures scoped memories  |

All share `DATABASE_URL`.

## How It Works

- **Auto-capture (`agent_end`):** extracts user+assistant turns → backend (PHI-gated per sender).
- **Auto-recall (`before_agent_start`):** searches the graph for prompt-relevant facts → injects via `prependContext` (PHI-gated per sender).

### Agent Tools (backend-stable)

- **`memory_search`** — search the graph for facts by natural-language query.
- **`memory_recall`** — retrieve recent conversation episodes.
- **`memory_store`** — persist a memory (text).
- `graphiti_search` / `graphiti_episodes` — **deprecated aliases** of `memory_search` / `memory_recall` (kept one release).

All tools are PHI-gated (fail closed on cloud — see the tripwire note above).

### CLI

```bash
openclaw graphiti status   # Check server/API connectivity
```

## Operational prerequisite (prod cutover)

Real-user memory is **gated on the self-hosted Graphiti backend shipping** (the RELEASE RULE). Self-hosted **deploy ownership** (provision, backups, availability) + the **redaction** follow-up are prod-cutover prerequisites, deferred and to be assigned by the principal/devex when cutover nears — they are NOT a code dependency of this plugin.

## Development

```bash
pnpm vitest run -c vitest.extensions.config.ts extensions/memory-graphiti        # unit
GETZEP_API_KEY=<key> pnpm vitest run extensions/memory-graphiti/integration.test.ts   # integration (needs a key)
```
