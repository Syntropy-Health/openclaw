/**
 * Unit tests for the SyntropyVault wrapper around Supabase Vault.
 *
 * The wrapper exposes a tiny name→value KV interface backed by three
 * SECURITY DEFINER RPCs in the mobile Supabase project:
 *
 *   app_syntropy_token_set(p_name text, p_plaintext text) returns void
 *   app_syntropy_token_get(p_name text) returns text  -- null if missing
 *   app_syntropy_token_delete(p_name text) returns void
 *
 * These RPCs wrap `vault.create_secret`, `vault.decrypted_secrets`, and
 * `vault.delete_secret` respectively. Defining them on the Supabase side
 * (rather than directly hitting `vault.secrets`) gives us:
 *   - One audited surface to grant `service_role` access to
 *   - A stable contract decoupled from the Supabase Vault internal schema
 *
 * Tests use a mock RpcCaller so we never need a live Supabase project.
 */

import { describe, test, expect, vi } from "vitest";
import { SyntropyVault, type RpcCaller } from "./vault.js";

function createMockRpc(impl: (fn: string, args: Record<string, unknown>) => unknown): RpcCaller {
  return {
    call: vi.fn(async (fn: string, args: Record<string, unknown>) =>
      impl(fn, args),
    ) as RpcCaller["call"],
  };
}

describe("SyntropyVault.set", () => {
  test("calls app_syntropy_token_set with name + plaintext", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rpc = createMockRpc((fn, args) => {
      calls.push({ fn, args });
      return null;
    });
    const vault = new SyntropyVault(rpc);
    await vault.set("syntropy_user_abc", "sj_secret_xyz");
    expect(calls).toEqual([
      {
        fn: "app_syntropy_token_set",
        args: { p_name: "syntropy_user_abc", p_plaintext: "sj_secret_xyz" },
      },
    ]);
  });

  test("rejects on RPC error", async () => {
    const rpc = createMockRpc(() => {
      throw new Error("network down");
    });
    const vault = new SyntropyVault(rpc);
    await expect(vault.set("name", "value")).rejects.toThrow(/network down/);
  });

  test("rejects on empty name", async () => {
    const rpc = createMockRpc(() => null);
    const vault = new SyntropyVault(rpc);
    await expect(vault.set("", "value")).rejects.toThrow(/name/);
  });

  test("rejects on empty plaintext", async () => {
    const rpc = createMockRpc(() => null);
    const vault = new SyntropyVault(rpc);
    await expect(vault.set("name", "")).rejects.toThrow(/plaintext/);
  });
});

describe("SyntropyVault.get", () => {
  test("returns plaintext for an existing name", async () => {
    const rpc = createMockRpc((fn, args) => {
      expect(fn).toBe("app_syntropy_token_get");
      expect(args).toEqual({ p_name: "syntropy_user_abc" });
      return "sj_secret_xyz";
    });
    const vault = new SyntropyVault(rpc);
    const got = await vault.get("syntropy_user_abc");
    expect(got).toBe("sj_secret_xyz");
  });

  test("returns null when the secret is missing (RPC returns null)", async () => {
    const rpc = createMockRpc(() => null);
    const vault = new SyntropyVault(rpc);
    const got = await vault.get("does-not-exist");
    expect(got).toBeNull();
  });

  test("returns null when the secret is missing (RPC returns undefined)", async () => {
    const rpc = createMockRpc(() => undefined);
    const vault = new SyntropyVault(rpc);
    const got = await vault.get("does-not-exist");
    expect(got).toBeNull();
  });

  test("rejects on RPC error", async () => {
    const rpc = createMockRpc(() => {
      throw new Error("upstream timeout");
    });
    const vault = new SyntropyVault(rpc);
    await expect(vault.get("name")).rejects.toThrow(/upstream timeout/);
  });

  test("rejects on empty name", async () => {
    const rpc = createMockRpc(() => null);
    const vault = new SyntropyVault(rpc);
    await expect(vault.get("")).rejects.toThrow(/name/);
  });
});

describe("SyntropyVault.delete", () => {
  test("calls app_syntropy_token_delete with name", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rpc = createMockRpc((fn, args) => {
      calls.push({ fn, args });
      return null;
    });
    const vault = new SyntropyVault(rpc);
    await vault.delete("syntropy_user_abc");
    expect(calls).toEqual([
      { fn: "app_syntropy_token_delete", args: { p_name: "syntropy_user_abc" } },
    ]);
  });

  test("rejects on RPC error", async () => {
    const rpc = createMockRpc(() => {
      throw new Error("forbidden");
    });
    const vault = new SyntropyVault(rpc);
    await expect(vault.delete("name")).rejects.toThrow(/forbidden/);
  });

  test("rejects on empty name", async () => {
    const rpc = createMockRpc(() => null);
    const vault = new SyntropyVault(rpc);
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
