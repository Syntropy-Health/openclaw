/**
 * Tests for the register-time service-auth seam (`maybeCreateServiceAuthProvider`).
 *
 * The seam constructs the openclaw → SJ /mcp M2M provider at plugin register()
 * time so the eventual MCP-tool consumer drops in. It must:
 *  - build a provider when the `resource` URI is configured (pluginConfig or env);
 *  - return null (non-fatal) when no `resource` is configured;
 *  - never log the machine secret value (length-only debug);
 *  - produce a provider that fails closed when the machine secret is absent.
 */

import { describe, test, expect, vi } from "vitest";
import { maybeCreateServiceAuthProvider } from "./index.js";

const SJ_MCP = "https://shrine-api-test.up.railway.app/mcp";

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("maybeCreateServiceAuthProvider", () => {
  test("builds a provider from pluginConfig.serviceAuthResource", () => {
    const log = logger();
    const provider = maybeCreateServiceAuthProvider(
      { serviceAuthResource: SJ_MCP },
      { CLERK_MACHINE_SECRET_KEY: "ak_secret_value", NODE_ENV: "production" } as NodeJS.ProcessEnv,
      log,
    );
    expect(provider).not.toBeNull();
    expect(provider!.secretMissing).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  test("builds from SYNTROPY_MCP_RESOURCE_URL env when pluginConfig absent", () => {
    const log = logger();
    const provider = maybeCreateServiceAuthProvider(
      undefined,
      { SYNTROPY_MCP_RESOURCE_URL: SJ_MCP, CLERK_MACHINE_SECRET_KEY: "ak_x" } as NodeJS.ProcessEnv,
      log,
    );
    expect(provider).not.toBeNull();
  });

  test("returns null (non-fatal) and warns when no resource configured", () => {
    const log = logger();
    const provider = maybeCreateServiceAuthProvider(
      {},
      { CLERK_MACHINE_SECRET_KEY: "ak_x" } as NodeJS.ProcessEnv,
      log,
    );
    expect(provider).toBeNull();
    // F11: missing resource is BENIGN (machine path simply not configured) →
    // info, not warn. A warn here would be log-noise for an unconfigured path.
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("F11: a malformed resource fails LOUDLY (warn), not silently as 'not configured'", () => {
    const log = logger();
    const provider = maybeCreateServiceAuthProvider(
      { serviceAuthResource: "not-a-url" },
      { CLERK_MACHINE_SECRET_KEY: "ak_x" } as NodeJS.ProcessEnv,
      log,
    );
    expect(provider).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls.flat().join("\n")).toMatch(/MISCONFIGURED/);
    expect(log.info).not.toHaveBeenCalled();
  });

  test("never logs the machine secret value — length-only", () => {
    const log = logger();
    const secret = "ak_super_secret_do_not_log_123456";
    maybeCreateServiceAuthProvider(
      { serviceAuthResource: SJ_MCP },
      { CLERK_MACHINE_SECRET_KEY: secret } as NodeJS.ProcessEnv,
      log,
    );
    const allLogged = [...log.info.mock.calls, ...log.warn.mock.calls].flat().join("\n");
    expect(allLogged).not.toContain(secret);
    expect(allLogged).toContain(`len=${secret.length}`);
  });

  test("provider built without a machine secret still fails closed at call time", async () => {
    const log = logger();
    const provider = maybeCreateServiceAuthProvider(
      { serviceAuthResource: SJ_MCP },
      { NODE_ENV: "production" } as NodeJS.ProcessEnv,
      log,
    );
    expect(provider).not.toBeNull();
    expect(provider!.secretMissing).toBe(true);
    await expect(provider!.getToken()).rejects.toThrow(/fail-closed/);
    // The log notes the secret is ABSENT (fail-closed), without a value.
    const logged = log.info.mock.calls.flat().join("\n");
    expect(logged).toContain("ABSENT");
  });
});
