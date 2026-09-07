# Migrating `shrine-openclaw-chat-staging` from Fly to Railway

Status: **config written, migration NOT executed.** No Fly or Railway credential
is present in the devex environment; every step below that touches a platform is
listed with what it needs.

---

## ⛔ THE ORDERING IS THE WHOLE RISK — SPIN DOWN LAST

The instruction was "spin down Fly and centralize on Railway." **Done in that
order it destroys credentials that exist nowhere else.**

`fly.toml` mounts a persistent volume:

```
[env]     OPENCLAW_STATE_DIR = "/data"
[mounts]  source = "openclaw_data"   destination = "/data"
```

and `scripts/fly/bootstrap-config.mjs` says exactly what lives there:

> leaving runtime-managed keys (`gateway.auth.token`, `talk.apiKey`, `agents.*`) intact

The script replaces **only** the `plugins` key from the repo on each boot.
Everything else in `/data/openclaw.json` — the gateway auth token, the talk API
key, agent state — **has no copy in git, in Infisical, or anywhere else**. This
is the same persistence finding filed as monorepo **#252**: nothing reconciles
`/data`, so a single past deploy governs it indefinitely.

**Destroying the Fly app destroys the volume destroys those secrets.** They are
not recoverable from the repo, and re-issuing them means every client holding
the old gateway token breaks.

So the order is fixed:

```
1. CAPTURE   /data/openclaw.json off the Fly volume        <- BEFORE anything
2. STAND UP  the Railway service, restore state, verify
3. CUT OVER  DNS / consumers
4. ONLY THEN destroy the Fly app
```

Step 4 is irreversible and is the last step, not the first.

---

## 1. Capture the volume state — needs Fly auth

```sh
fly ssh console -a shrine-openclaw-chat-staging -C "cat /data/openclaw.json"
```

Store the result in **Infisical**, not a file and not a transcript — it contains
live credentials. Suggested: `/openclaw/staging` → `OPENCLAW_STATE_JSON`.

**Verify you captured it before proceeding.** An empty or partial read here is
the one failure that cannot be undone later.

## 2. What Railway must reproduce

| Fly | Railway equivalent |
|---|---|
| `[build] dockerfile = "Dockerfile"` | `railway.json` → `builder: DOCKERFILE` |
| `internal_port = 3000` | **`$PORT`, injected — do NOT hardcode 3000** |
| `[mounts] openclaw_data → /data` | a Railway **volume mounted at `/data`** |
| `auto_stop_machines = false`, `min_machines_running = 1` | no sleep; 1 replica |
| `shared-cpu-2x`, `2048mb` | ≥2GB — `NODE_OPTIONS=--max-old-space-size=1536` |
| `[env] NODE_ENV`, `OPENCLAW_PREFER_PNPM`, `OPENCLAW_STATE_DIR=/data`, `NODE_OPTIONS` | same four service variables |

**The `$PORT` difference is not cosmetic.** Railway routes to the port it
assigns; a service listening on a hardcoded 3000 fails its healthcheck and the
deploy never becomes ready. `railway.json` uses `${PORT:-3000}` so it still runs
locally.

**The volume is not optional.** Without a volume at `/data`, `OPENCLAW_STATE_DIR`
points at ephemeral container storage: the gateway re-issues its auth token on
every restart and every client breaks silently. That reproduces the Fly
behaviour's *shape* while losing its *durability*, which is the worst of both.

`scripts/fly/bootstrap-config.mjs` is platform-agnostic despite the path — it
only merges JSON — so it is reused as-is rather than forked. The `fly/` in its
name will mislead the next reader; renaming it is a follow-up, not part of a
migration that already changes the runtime.

## 3. Verification before cutover — assert the ARTIFACT, not "green"

A Railway deploy reporting success is not evidence the service works. Before
touching DNS:

```sh
curl -sf https://<railway-host>/v1/models          # 200, and lists models
curl -so /dev/null -w '%{http_code}' <host>/v1/responses   # matches Fly's 405
```

Then **compare against the live Fly instance**, which is the only ground truth
for what the current config actually resolves to (per #252, the effective
runMode lives in `/data` and cannot be read from the repo):

```
Fly today:  /  200   /v1/models  200   /v1/responses  405
```

A difference here means the restored `/data` did not take, and it is far cheaper
to discover before the Fly app is gone than after.

## 4. Spin down — irreversible, last, and not without sign-off

```sh
fly apps destroy shrine-openclaw-chat-staging
```

Do not run this until 1–3 are done and verified. Destroying the app destroys the
volume; there is no undo, and the capture in step 1 is the only thing standing
between a migration and a credential loss.

---

## Credentials required (none held by devex)

| Step | Needs |
|---|---|
| 1 capture | Fly auth (`FLY_API_TOKEN` / `flyctl auth login`) |
| 2 stand up | Railway auth + project |
| 3 verify | none — plain HTTPS probes |
| 4 destroy | Fly auth, **plus explicit sign-off** |

Measured 2026-09-07: `FLY_API_TOKEN`, `FLY_ACCESS_TOKEN`, `FLYCTL_ACCESS_TOKEN`
all unset; `flyctl auth whoami` → *"no access token available"*.
