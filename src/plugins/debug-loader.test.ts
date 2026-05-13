import { afterEach, describe, expect, test, vi } from "vitest";
import { debugLoader, resetDebugLoaderCacheForTests } from "./debug-loader.js";

describe("debugLoader", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_DEBUG_PLUGIN_LOADER;
    resetDebugLoaderCacheForTests();
    vi.restoreAllMocks();
  });

  test("writes nothing when env var unset", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    debugLoader("hello");
    expect(spy).not.toHaveBeenCalled();
  });

  test("writes prefixed line when env var = '1'", () => {
    process.env.OPENCLAW_DEBUG_PLUGIN_LOADER = "1";
    resetDebugLoaderCacheForTests();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    debugLoader("discovery candidates=8");
    expect(spy).toHaveBeenCalledWith("OPENCLAW_PLUGIN_LOADER: discovery candidates=8\n");
  });

  test("treats env var = 'true' as enabled", () => {
    process.env.OPENCLAW_DEBUG_PLUGIN_LOADER = "true";
    resetDebugLoaderCacheForTests();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    debugLoader("x");
    expect(spy).toHaveBeenCalled();
  });

  test("treats env var = '0' as disabled", () => {
    process.env.OPENCLAW_DEBUG_PLUGIN_LOADER = "0";
    resetDebugLoaderCacheForTests();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    debugLoader("x");
    expect(spy).not.toHaveBeenCalled();
  });
});
