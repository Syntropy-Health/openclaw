/**
 * An insecure or blank auth endpoint refuses registration, naming the
 * setting, before any connection is opened.
 */

import { describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

// Records whether registration ever tries to open a connection; no driver is loaded.
const connectAttempts = vi.hoisted(() => ({ count: 0 }));
vi.mock("./db.js", () => ({
  createPgClient: () => {
    connectAttempts.count += 1;
    throw new Error("unexpected connection attempt");
  },
}));

describe("persist-user-identity register()", () => {
  test("an insecure auth endpoint refuses registration before connecting", async () => {
    const { default: plugin } = await import("./index.js");
    const info = vi.fn();
    const api = {
      pluginConfig: {
        databaseUrl: "postgresql://mock/test",
        auth: { mode: "passcode-endpoint", passcodeVerifyUrl: "http://auth.example.test/verify" },
      },
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    expect(() => plugin.register(api)).toThrow("auth.passcodeVerifyUrl");
    // The refusal precedes any connection.
    expect(connectAttempts.count).toBe(0);
    expect(info.mock.calls.flat().join(" ")).not.toContain("connecting");
  });
});
