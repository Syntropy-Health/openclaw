/**
 * #68 step 1 — the pairing token write must go through the SINGLE producer
 * (`upsertSyntropyToken`) and land in Vault, never as plaintext in the legacy
 * `syntropy_tokens.auth_token` column.
 *
 * WHY THIS FILE EXISTS: before this change `commands.ts` hand-rolled its own
 * `INSERT INTO syntropy_tokens (user_id, auth_token, origin)` with the plaintext
 * bound as a VALUE and no vault branch at all — a second, vault-blind producer
 * on a table that `db.ts` already owned. It was reachable from the live `!verify`
 * pairing flow and it was completely untested, which is how it drifted.
 *
 * The assertions below are deliberately written against the SQL text and the
 * vault client rather than a return code: the CTO's verification bar for this
 * slice is "prove a post-change pairing write lands in Vault and NOT in the old
 * column, on the persist-user-identity path specifically". A test that only
 * asserted "it didn't throw" is exactly the indistinguishable-from-success
 * shape this ticket exists to remove.
 */

import { describe, expect, it, vi } from "vitest";

// Mirror db.test.ts: stub vault.js so this suite doesn't pull @supabase/supabase-js
// transitively. The vault RPC contract has its own coverage in vault.test.ts.
vi.mock("../../syntropy/src/vault.js", () => ({
  secretNameForUser: (userId: string) => `syntropy_user_${userId}`,
  createSyntropyVault: vi.fn(),
  vaultRpcsInstalled: vi.fn(async () => true),
}));

import { upsertSyntropyToken } from "../../syntropy/src/db.js";
import type { SyntropyVault } from "../../syntropy/src/vault.js";

type RecordedCall = { query: string; params: unknown[] };

/** Template-tag sql stub that records the query text + bound params. */
function makeRecordingSql() {
  const calls: RecordedCall[] = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ query: strings.join("?"), params });
    return Promise.resolve([] as unknown[]);
  });
  return { sql: sql as unknown as import("postgres").Sql, calls };
}

function makeMockVault(store: Record<string, string> = {}) {
  return {
    set: vi.fn(async (name: string, value: string) => {
      store[name] = value;
    }),
    get: vi.fn(async (name: string) => store[name] ?? null),
  } as unknown as SyntropyVault & { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
}

const PAIRING_TOKEN = "sj_pairtest_plaintextsecret";

describe("#68 step 1 — pairing token persistence goes through the single producer", () => {
  it("writes the pairing token to Vault and binds NO plaintext into the SQL", async () => {
    const { sql, calls } = makeRecordingSql();
    const vault = makeMockVault();

    await upsertSyntropyToken(sql, vault, "user-uuid-pair", PAIRING_TOKEN, "pairing");

    // The plaintext went to Vault under the per-user secret name.
    expect(vault.set).toHaveBeenCalledTimes(1);
    expect(vault.set).toHaveBeenCalledWith("syntropy_user_user-uuid-pair", PAIRING_TOKEN);

    // THE LOAD-BEARING ASSERTION: the plaintext must not appear as a bound
    // parameter on ANY statement. The original defect bound it as a VALUE, so
    // asserting on the query text alone would not have caught it.
    for (const call of calls) {
      expect(call.params).not.toContain(PAIRING_TOKEN);
    }

    // And the legacy column is explicitly nulled, not merely omitted.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatch(/auth_token\s*=\s*NULL/);
  });

  it("preserves the 'pairing' origin so the row provenance stays honest", async () => {
    const { sql, calls } = makeRecordingSql();
    const vault = makeMockVault();

    await upsertSyntropyToken(sql, vault, "user-uuid-origin", PAIRING_TOKEN, "pairing");

    expect(calls[0]!.params).toContain("pairing");
  });
});

describe("#68 step 1 — the vault must be resolved LAZILY, not captured at registration", () => {
  /**
   * THE SILENT-NO-OP GUARD. register() resolves the vault inside ensureReady()
   * (an RPC round-trip it must not await at registration), but the command
   * handlers are registered — and their deps destructured — before that. If the
   * dep were a VALUE rather than a getter it would capture `null` forever and
   * every production pairing would quietly take the plaintext path while every
   * other test in this file still passed.
   *
   * That is the exact shape this ticket exists to remove, so it gets its own
   * executable guard rather than trusting the review that introduced it.
   */
  it("does not call getVault during registerIdentityCommands (no eager capture)", async () => {
    const { registerIdentityCommands } = await import("./commands.js");

    const getVault = vi.fn(() => null);
    const api = {
      registerCommand: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };

    registerIdentityCommands(api as never, {
      sql: makeRecordingSql().sql,
      getVault,
      authConfig: undefined,
      ensureReady: async () => {},
      pendingIdentify: new Map(),
    });

    // Commands were registered...
    expect(api.registerCommand).toHaveBeenCalled();
    // ...but the vault was NOT read yet. Reading it here is the bug.
    expect(getVault).not.toHaveBeenCalled();
  });
});

describe("#68 step 1 — commands.ts must not carry its own INSERT", () => {
  it("has no hand-rolled INSERT INTO syntropy_tokens in the command handler source", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(new URL("./commands.ts", import.meta.url), "utf8");

    // Strip comments before matching. The guard is about what the CODE does;
    // the docblock above the call deliberately quotes the old statement to
    // explain what was removed, and prose describing a defect must not read as
    // the defect itself.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    // The drift mechanism itself: a second producer writing the same table.
    // Patching the INSERT in place would leave this regression path open, so
    // the guard is on the SHAPE (no local INSERT), not on the bound values.
    expect(code).not.toMatch(/INSERT\s+INTO\s+syntropy_tokens/i);
    // It must delegate to the single producer instead.
    expect(code).toMatch(/upsertSyntropyToken/);
  });
});
