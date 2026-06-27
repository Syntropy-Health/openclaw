/**
 * Braintrust init tests for the syntropy register() path.
 *
 * Exercises `initBraintrustTracer` (extracted from register() so it's testable
 * without a real braintrust login or DB). `loadBraintrust` is injected so the
 * SDK is fully mocked. Covers:
 *   - enabled + apiKey → initLogger called ONCE with {projectName:"claw"};
 *     returns a working tracer
 *   - enabled + NO apiKey → warn + NO init, returns undefined (no throw)
 *   - disabled → initLogger NOT called, returns undefined
 *   - import/login failure → error logged, returns undefined (fail-safe)
 *   - logContent=true → extra PHI warning emitted
 */

import { describe, expect, it, vi } from "vitest";
import { initBraintrustTracer } from "./index.js";
import type { TracedFn } from "./tracer.js";

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const noopTraced: TracedFn = async (cb) =>
  cb({
    log() {
      /* noop */
    },
  });

describe("initBraintrustTracer", () => {
  it("enabled + apiKey → initLogger called once with {projectName:'claw'}; returns a tracer", async () => {
    const logger = fakeLogger();
    const initLogger = vi.fn();
    const load = vi.fn(async () => ({ initLogger, traced: noopTraced }));

    const tracer = await initBraintrustTracer(
      { enabled: true, apiKey: "bt_key", projectName: "claw", logContent: false },
      logger,
      load,
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(initLogger).toHaveBeenCalledTimes(1);
    expect(initLogger).toHaveBeenCalledWith({ projectName: "claw", apiKey: "bt_key" });
    expect(tracer).toBeDefined();
    expect(typeof tracer!.traceMcp).toBe("function");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("enabled + NO apiKey → warns and does NOT init (no throw); returns undefined", async () => {
    const logger = fakeLogger();
    const initLogger = vi.fn();
    const load = vi.fn(async () => ({ initLogger, traced: noopTraced }));

    const tracer = await initBraintrustTracer(
      { enabled: true, projectName: "claw", logContent: false },
      logger,
      load,
    );

    expect(tracer).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(initLogger).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/BRAINTRUST_API_KEY/);
  });

  it("disabled → initLogger NOT called; returns undefined; no dep load", async () => {
    const logger = fakeLogger();
    const initLogger = vi.fn();
    const load = vi.fn(async () => ({ initLogger, traced: noopTraced }));

    const tracer = await initBraintrustTracer(
      { enabled: false, apiKey: "bt_key", projectName: "claw", logContent: false },
      logger,
      load,
    );

    expect(tracer).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(initLogger).not.toHaveBeenCalled();
  });

  it("import/login failure → logs error, returns undefined (never throws)", async () => {
    const logger = fakeLogger();
    const load = vi.fn(async () => {
      throw new Error("network blocked");
    });

    const tracer = await initBraintrustTracer(
      { enabled: true, apiKey: "bt_key", projectName: "claw", logContent: false },
      logger,
      load,
    );

    expect(tracer).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/network blocked/);
  });

  it("logContent=true → emits the PHI cloud warning", async () => {
    const logger = fakeLogger();
    const initLogger = vi.fn();
    const load = vi.fn(async () => ({ initLogger, traced: noopTraced }));

    await initBraintrustTracer(
      { enabled: true, apiKey: "bt_key", projectName: "claw", logContent: true },
      logger,
      load,
    );

    const warned = logger.warn.mock.calls.map((c) => c[0]).join("\n");
    expect(warned).toMatch(/PHI/);
    expect(warned).toMatch(/synthetic-data ONLY/i);
  });
});
