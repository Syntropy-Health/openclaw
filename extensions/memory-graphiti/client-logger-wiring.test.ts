/**
 * The plugin's client factory hands its logger to the memory client, so a listing
 * truncated at the backend ceiling is actually reported in production (before,
 * the client was built without one and its warning never fired).
 */
import { describe, expect, it, vi } from "vitest";

/** Options each ZepCloudClient was built with, so the register-level arm can see them. */
const built = vi.hoisted(() => ({ opts: [] as Array<{ logger?: { warn: (m: string) => void } }> }));
vi.mock("./zep-cloud-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./zep-cloud-client.js")>();
  class RecordingZepCloudClient extends actual.ZepCloudClient {
    constructor(apiKey: string, opts: ConstructorParameters<typeof actual.ZepCloudClient>[1] = {}) {
      super(apiKey, opts);
      built.opts.push(opts);
    }
  }
  return { ...actual, ZepCloudClient: RecordingZepCloudClient };
});
import type { GraphitiConfig } from "./config.js";
import { createClient } from "./index.js";
import { factFixture } from "./testing/memory-client.contract.js";
import { attachSdk, createZepSdkFake } from "./testing/zep-sdk-fake.js";
import { ZEP_LIST_CEILING } from "./zep-cloud-client.js";

describe("createClient wires the logger into the memory client", () => {
  it("RED: a Zep listing truncated at the ceiling warns through the plugin's logger", async () => {
    const warn = vi.fn();
    const client = createClient(
      { backend: "zep-cloud", apiKey: "z_key" } as unknown as GraphitiConfig,
      { warn },
    );
    const fake = createZepSdkFake();
    attachSdk(client, fake.zep);
    fake.seed(
      "ok_g",
      Array.from({ length: ZEP_LIST_CEILING + 30 }, (_, i) => factFixture(i + 1)),
    );
    const r = await client.listFacts("ok_g");
    expect(r.truncated).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("truncated at the 2000-fact ceiling"),
    );
  });

  it("RED: register() builds the client with the PLUGIN's logger (the production call site)", async () => {
    built.opts.length = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const noop = vi.fn();
    const api = {
      id: "memory-graphiti",
      name: "Memory (Graphiti)",
      source: "test",
      // A provably QA-only WhatsApp allow-list, so the PHI tripwire admits zep-cloud.
      config: { channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+15555550001"] } } },
      pluginConfig: { backend: "zep-cloud", apiKey: "z_key", qaNumbers: ["+15555550001"] },
      runtime: {},
      logger,
      registerTool: noop,
      registerHook: noop,
      registerHttpHandler: noop,
      registerHttpRoute: noop,
      registerChannel: noop,
      registerGatewayMethod: noop,
      registerCli: noop,
      registerService: noop,
      registerProvider: noop,
      registerCommand: noop,
      resolvePath: (p: string) => p,
      on: noop,
    };
    const mod = await import("./index.js");
    await mod.default.register(api as never);
    expect(built.opts).toHaveLength(1);
    built.opts[0].logger?.warn("probe: listFacts truncated");
    expect(logger.warn).toHaveBeenCalledWith("probe: listFacts truncated");
  });
});
