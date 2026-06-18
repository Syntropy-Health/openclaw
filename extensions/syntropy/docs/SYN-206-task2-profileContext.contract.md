# SYN-206 Task 2 — `before_agent_start` profile-context injection contract

Shared spec for sealed-referee TDD. The test-author writes the sealed suite from
this; the implementer implements from this, blind to the tests.

Task 2 wires Task 1's `formatProfileBlock` into the agent: on `before_agent_start`
for a paired user, fetch their health profile, format it, and inject it as
`prependContext` — TtlCache-bounded, identity-gated, failure-safe.

## Part A — testable unit: `resolveProfileContext` (NEW `extensions/syntropy/src/profile-context.ts`)

```ts
import type { SyntropyToolResult } from "./client.js"; // { data: unknown; ok: boolean; error?: string }
import type { TtlCache } from "./cache.js";

export async function resolveProfileContext(opts: {
  cache: TtlCache<string, string>;
  cacheKey: string;
  fetchProfile: () => Promise<SyntropyToolResult>;
}): Promise<string | null>;
```

Behavior:

1. **Cache hit** — if `cache.get(cacheKey)` returns a string, return it directly.
   MUST NOT call `fetchProfile` on a hit.
2. **Cache miss** — `await fetchProfile()`:
   - If the result is not ok (`ok === false`) → return `null` (inject nothing).
   - If ok → `block = formatProfileBlock(result.data)` (Task 1 fn, imported from
     `./profile.js`):
     - non-empty string → `cache.set(cacheKey, block)`, return `block`.
     - `null` (envelope/empty/malformed) → return `null` and do **NOT** cache.
3. **Failure-safe** — if `fetchProfile()` rejects/throws, catch and return `null`.
   `resolveProfileContext` MUST NOT throw for any input.

Rationale: caching only non-null blocks means a transient empty/failed profile is
re-checked next turn (cheap), while a real profile is served from cache for the
TTL without re-hitting SJ.

## Part B — wiring: `before_agent_start` (EDIT `extensions/syntropy/src/index.ts`)

The hook (priority 35) already resolves the user and, on success, caches the
`ResolvedUser` for the tool factory. Extend it:

- Add a module-level second cache alongside `resolvedUsers`:
  `const profileBlocks = new TtlCache<string, string>({ ttlMs: USER_CACHE_TTL_MS, maxSize: USER_CACHE_MAX_SIZE });`
  (Same 10-min TTL / 10k bound. Key: the existing `${channel}:${peerId}` cacheKey.)
- **Unpaired** (`!user`): unchanged behavior — `resolvedUsers.delete(cacheKey)`,
  also `profileBlocks.delete(cacheKey)`, return `{ prependContext: SYNTROPY_GATE }`.
- **Paired**: after `resolvedUsers.set(cacheKey, user)`, call:
  ```ts
  const block = await resolveProfileContext({
    cache: profileBlocks,
    cacheKey,
    fetchProfile: () => callSyntropyTool(syntropyBaseUrl, user.authToken, "get_health_profile", {}),
  });
  return block ? { prependContext: block } : {};
  ```
- The hook's existing top-level `try/catch` (returns `{}` on error) is preserved —
  defence in depth; `resolveProfileContext` is already failure-safe.

Invariants the wiring must preserve:

- A paired user's profile is injected **without** the agent calling the
  `syntropy_health_profile` tool.
- An unpaired user still gets `[SYNTROPY_GATE]`, no profile block, no health tools.
- A profile fetch failure (SJ 5xx/timeout/envelope) never blocks the reply — the
  hook returns `{}` and the agent proceeds.
- Identity scoping is unchanged: the block is keyed by `${channel}:${peerId}`, so a
  user can never receive another user's profile.

## Out of scope (Task 2)

- The formatter itself (Task 1, shipped).
- Egress/observability PHI redaction (separate slice — the prepend block must be
  redacted at Logfire/Braintrust/n8n spans, not here).
- Push-invalidate on SJ profile-update webhook (deferred; 10-min TTL suffices).
