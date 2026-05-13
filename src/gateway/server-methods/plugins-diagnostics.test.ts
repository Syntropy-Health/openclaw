import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginsDiagnosticsHandlers } from "./plugins-diagnostics.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveBundledPluginsDir: vi.fn<() => string | undefined>(),
  getActivePluginRegistry: vi.fn(),
}));

vi.mock("../../plugins/bundled-dir.js", () => ({
  resolveBundledPluginsDir: (...args: unknown[]) =>
    (mocks.resolveBundledPluginsDir as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: unknown[]) =>
    (mocks.getActivePluginRegistry as (...args: unknown[]) => unknown)(...args),
}));

const makeContext = (): GatewayRequestContext =>
  ({
    logGateway: { info: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

async function callDiagnostics() {
  return await new Promise<{ ok: boolean; payload?: unknown; error?: unknown }>((resolve) => {
    void pluginsDiagnosticsHandlers["gateway.plugins.diagnostics"]({
      req: { type: "req", id: "test-diag", method: "gateway.plugins.diagnostics" },
      params: {},
      respond: (ok, payload, error) => resolve({ ok, payload, error }),
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });
  });
}

beforeEach(() => {
  mocks.resolveBundledPluginsDir.mockReset();
  mocks.getActivePluginRegistry.mockReset();
});

describe("gateway.plugins.diagnostics handler", () => {
  it("returns an empty payload when the active registry is null", async () => {
    mocks.resolveBundledPluginsDir.mockReturnValue("/srv/openclaw/extensions");
    mocks.getActivePluginRegistry.mockReturnValue(null);

    const res = await callDiagnostics();

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    const payload = res.payload as {
      bundledPluginsDir: string | null;
      plugins: unknown[];
      diagnostics: unknown[];
    };
    expect(payload.bundledPluginsDir).toBe("/srv/openclaw/extensions");
    expect(payload.plugins).toEqual([]);
    expect(payload.diagnostics).toEqual([]);
  });

  it("normalizes an unresolved bundled dir to null", async () => {
    mocks.resolveBundledPluginsDir.mockReturnValue(undefined);
    mocks.getActivePluginRegistry.mockReturnValue(null);

    const res = await callDiagnostics();

    const payload = res.payload as { bundledPluginsDir: string | null };
    expect(payload.bundledPluginsDir).toBeNull();
  });

  it("returns whitelisted plugin fields and the diagnostics array", async () => {
    mocks.resolveBundledPluginsDir.mockReturnValue("/srv/openclaw/extensions");
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "syntropy",
          name: "Syntropy",
          version: "1.2.3",
          description: "internal description not exposed",
          source: "/srv/openclaw/extensions/syntropy/index.js",
          origin: "bundled",
          enabled: true,
          status: "loaded",
          toolNames: ["t1"],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          configSchema: true,
          configJsonSchema: {
            type: "object",
            properties: { secret: { type: "string" } },
          },
        },
      ],
      diagnostics: [
        {
          level: "warn",
          message: "missing optional dep",
          pluginId: "syntropy",
          source: "/srv/openclaw/extensions/syntropy/index.js",
        },
      ],
      tools: [],
      hooks: [],
      typedHooks: [],
      channels: [],
      providers: [],
      gatewayHandlers: {},
      httpHandlers: [],
      httpRoutes: [],
      cliRegistrars: [],
      services: [],
      commands: [],
    });

    const res = await callDiagnostics();

    expect(res.ok).toBe(true);
    const payload = res.payload as {
      bundledPluginsDir: string | null;
      plugins: Array<Record<string, unknown>>;
      diagnostics: Array<Record<string, unknown>>;
    };
    expect(payload.bundledPluginsDir).toBe("/srv/openclaw/extensions");
    expect(payload.plugins).toHaveLength(1);

    const [plugin] = payload.plugins;
    expect(plugin).toEqual({
      id: "syntropy",
      name: "Syntropy",
      version: "1.2.3",
      origin: "bundled",
      source: "/srv/openclaw/extensions/syntropy/index.js",
      status: "loaded",
      enabled: true,
      error: null,
    });
    // Info-leak prevention: the response must NOT carry the config schema or
    // any field outside the whitelist.
    expect(plugin).not.toHaveProperty("configJsonSchema");
    expect(plugin).not.toHaveProperty("description");
    expect(plugin).not.toHaveProperty("toolNames");

    expect(payload.diagnostics).toEqual([
      {
        level: "warn",
        message: "missing optional dep",
        pluginId: "syntropy",
        source: "/srv/openclaw/extensions/syntropy/index.js",
      },
    ]);
  });

  it("normalizes a missing plugin version and error to null in the response", async () => {
    mocks.resolveBundledPluginsDir.mockReturnValue("/srv/openclaw/extensions");
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "broken",
          name: "Broken",
          source: "/srv/openclaw/extensions/broken/index.js",
          origin: "workspace",
          enabled: false,
          status: "error",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpHandlers: 0,
          hookCount: 0,
          configSchema: false,
        },
      ],
      diagnostics: [],
      tools: [],
      hooks: [],
      typedHooks: [],
      channels: [],
      providers: [],
      gatewayHandlers: {},
      httpHandlers: [],
      httpRoutes: [],
      cliRegistrars: [],
      services: [],
      commands: [],
    });

    const res = await callDiagnostics();
    const payload = res.payload as { plugins: Array<Record<string, unknown>> };
    expect(payload.plugins[0]?.version).toBeNull();
    expect(payload.plugins[0]?.error).toBeNull();
    expect(payload.plugins[0]?.status).toBe("error");
    expect(payload.plugins[0]?.enabled).toBe(false);
  });
});
