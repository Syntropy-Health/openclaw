/**
 * Unit tests for the SyntropyVault wrapper.
 *
 * The wrapper exposes a tiny name→value KV interface backed by three
 * SECURITY DEFINER Postgres functions:
 *
 *   app_syntropy_token_set(p_name text, p_plaintext text) returns void
 *   app_syntropy_token_get(p_name text) returns text  -- null if missing
 *   app_syntropy_token_delete(p_name text) returns void
 *
 * Tests use an injected `SqlExecutor` mock so we never need a live
 * Postgres / Supabase project.
 */

import { describe, test, expect, vi } from "vitest";
import { SyntropyVault, type SqlExecutor } from "./vault.js";

function createMockSql(
  scalarImpl: (fn: string, args: readonly unknown[]) => unknown = () => null,
): { sql: SqlExecutor; calls: Array<{ kind: "scalar" | "void"; fn: string; args: unknown[] }> } {
  const calls: Array<{ kind: "scalar" | "void"; fn: string; args: unknown[] }> = [];
  const sql: SqlExecutor = {
    callScalar: vi.fn(async (fn: string, args: readonly unknown[]) => {
      calls.push({ kind: "scalar", fn, args: [...args] });
      return scalarImpl(fn, args) as never;
    }) as SqlExecutor["callScalar"],
    callVoid: vi.fn(async (fn: string, args: readonly unknown[]) => {
      calls.push({ kind: "void", fn, args: [...args] });
    }),
  };
  return { sql, calls };
}

describe("SyntropyVault.set", () => {
  test("calls app_syntropy_token_set with name + plaintext", async () => {
    const { sql, calls } = createMockSql();
    const vault = new SyntropyVault(sql);
    await vault.set("syntropy_user_abc", "sj_secret_xyz");
    expect(calls).toEqual([
      { kind: "void", fn: "app_syntropy_token_set", args: ["syntropy_user_abc", "sj_secret_xyz"] },
    ]);
  });

  test("rejects on SQL error", async () => {
    const sql: SqlExecutor = {
      callScalar: async () => null,
      callVoid: async () => {
        throw new Error("network down");
      },
    };
    const vault = new SyntropyVault(sql);
    await expect(vault.set("name", "value")).rejects.toThrow(/network down/);
  });

  test("rejects on empty name", async () => {
    const { sql } = createMockSql();
    const vault = new SyntropyVault(sql);
    await expect(vault.set("", "value")).rejects.toThrow(/name/);
  });

  test("rejects on empty plaintext", async () => {
    const { sql } = createMockSql();
    const vault = new SyntropyVault(sql);
    await expect(vault.set("name", "")).rejects.toThrow(/plaintext/);
  });
});

describe("SyntropyVault.get", () => {
  test("returns plaintext for an existing name", async () => {
    const { sql, calls } = createMockSql(() => "sj_secret_xyz");
    const vault = new SyntropyVault(sql);
    const got = await vault.get("syntropy_user_abc");
    expect(got).toBe("sj_secret_xyz");
    expect(calls).toEqual([
      { kind: "scalar", fn: "app_syntropy_token_get", args: ["syntropy_user_abc"] },
    ]);
  });

  test("returns null when the secret is missing (SQL returns null)", async () => {
    const { sql } = createMockSql(() => null);
    const vault = new SyntropyVault(sql);
    const got = await vault.get("does-not-exist");
    expect(got).toBeNull();
  });

  test("returns null when the SQL returns undefined", async () => {
    const { sql } = createMockSql(() => undefined);
    const vault = new SyntropyVault(sql);
    const got = await vault.get("does-not-exist");
    expect(got).toBeNull();
  });

  test("rejects on SQL error", async () => {
    const sql: SqlExecutor = {
      callScalar: async () => {
        throw new Error("upstream timeout");
      },
      callVoid: async () => {},
    };
    const vault = new SyntropyVault(sql);
    await expect(vault.get("name")).rejects.toThrow(/upstream timeout/);
  });

  test("rejects on empty name", async () => {
    const { sql } = createMockSql();
    const vault = new SyntropyVault(sql);
    await expect(vault.get("")).rejects.toThrow(/name/);
  });
});

describe("SyntropyVault.delete", () => {
  test("calls app_syntropy_token_delete with name", async () => {
    const { sql, calls } = createMockSql();
    const vault = new SyntropyVault(sql);
    await vault.delete("syntropy_user_abc");
    expect(calls).toEqual([
      { kind: "void", fn: "app_syntropy_token_delete", args: ["syntropy_user_abc"] },
    ]);
  });

  test("rejects on SQL error", async () => {
    const sql: SqlExecutor = {
      callScalar: async () => null,
      callVoid: async () => {
        throw new Error("forbidden");
      },
    };
    const vault = new SyntropyVault(sql);
    await expect(vault.delete("name")).rejects.toThrow(/forbidden/);
  });

  test("rejects on empty name", async () => {
    const { sql } = createMockSql();
    const vault = new SyntropyVault(sql);
    await expect(vault.delete("")).rejects.toThrow(/name/);
  });
});

describe("secretNameFor helper", () => {
  test("returns a deterministic name for a user UUID", async () => {
    const { secretNameForUser } = await import("./vault.js");
    expect(secretNameForUser("abc-123")).toBe("syntropy_user_abc-123");
  });

  test("rejects empty user id", async () => {
    const { secretNameForUser } = await import("./vault.js");
    expect(() => secretNameForUser("")).toThrow(/userId/);
  });
});
