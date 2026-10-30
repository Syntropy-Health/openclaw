/**
 * retryDdlRace: CREATE ... IF NOT EXISTS does not cover two sessions creating the
 * same object at once (Postgres can raise a unique violation on its catalog). The
 * helper retries ONLY those "already exists" codes, a bounded number of times.
 */
import { describe, expect, it, vi } from "vitest";
import { DDL_RACE_CODES, retryDdlRace } from "./pg-pool.js";

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const noSleep = async () => undefined;

describe("retryDdlRace", () => {
  it("the happy path runs once and returns the result", async () => {
    const run = vi.fn(async () => "ok");
    expect(await retryDdlRace(run, { sleep: noSleep })).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  for (const code of ["23505", "42P07", "42710"]) {
    it(`retries a concurrent-create error (${code}) and then succeeds`, async () => {
      const run = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(pgError(code))
        .mockRejectedValueOnce(pgError(code))
        .mockResolvedValue("ok");
      expect(await retryDdlRace(run, { sleep: noSleep })).toBe("ok");
      expect(run).toHaveBeenCalledTimes(3);
    });
  }

  it("is bounded: after 5 attempts the last race error is thrown", async () => {
    const run = vi.fn(async () => {
      throw pgError("23505");
    });
    await expect(retryDdlRace(run, { sleep: noSleep })).rejects.toMatchObject({ code: "23505" });
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("any other error is thrown at once, never retried", async () => {
    for (const err of [pgError("42601"), pgError("08006"), new Error("no code")]) {
      const run = vi.fn(async () => {
        throw err;
      });
      await expect(retryDdlRace(run, { sleep: noSleep })).rejects.toBe(err);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("backs off between attempts with a short, growing delay", async () => {
    const waits: number[] = [];
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(pgError("42P07"))
      .mockRejectedValueOnce(pgError("42P07"))
      .mockResolvedValue("ok");
    await retryDdlRace(run, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(200);
  });

  it("names exactly the three concurrent-create codes", () => {
    expect([...DDL_RACE_CODES].toSorted()).toEqual(["23505", "42710", "42P07"]);
  });
});
