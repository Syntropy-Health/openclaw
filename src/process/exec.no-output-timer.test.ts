/**
 * The no-output timer of runCommandWithTimeout, on a fake clock and a fake child.
 *
 * The real-process version of this check depended on how fast a node child starts:
 * the timer arms at spawn, so a cold start longer than the window (common on a
 * busy Windows runner) killed the child before its first write. Here the clock and
 * the child's output are both controlled, so only the reset logic is under test.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = null;
  readonly pid = 4242;
  killed = false;
  kill(signal: string) {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
  /** Normal exit with a code. */
  exit(code: number) {
    this.emit("close", code, null);
  }
}

const children: FakeChild[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    }),
  };
});

const { runCommandWithTimeout } = await import("./exec.js");

const run = (noOutputTimeoutMs: number) =>
  runCommandWithTimeout(["some-tool", "--flag"], { timeoutMs: 60_000, noOutputTimeoutMs });

beforeEach(() => {
  vi.useFakeTimers();
  children.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runCommandWithTimeout no-output timer (fake clock)", () => {
  it("output inside the window resets it, so a long-running chatty command is not killed", async () => {
    const pending = run(160);
    const child = children[0];
    // 10 chunks 100 ms apart: 1 s in total, far past one 160 ms window.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      child.stdout.emit("data", Buffer.from("."));
    }
    child.exit(0);
    const result = await pending;
    expect(result).toMatchObject({
      code: 0,
      termination: "exit",
      noOutputTimedOut: false,
      killed: false,
    });
    expect(result.stdout).toBe("..........");
  });

  it("stderr output resets it too", async () => {
    const pending = run(160);
    const child = children[0];
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(150);
      child.stderr.emit("data", Buffer.from("x"));
    }
    child.exit(0);
    expect((await pending).noOutputTimedOut).toBe(false);
  });

  it("RED: a silence longer than the window kills the child as no-output-timeout", async () => {
    const pending = run(160);
    const child = children[0];
    await vi.advanceTimersByTimeAsync(100);
    child.stdout.emit("data", Buffer.from("."));
    await vi.advanceTimersByTimeAsync(160);
    // Checked before awaiting, so a timer that never fires fails here, not by hanging.
    expect(child.killed).toBe(true);
    const result = await pending;
    expect(result).toMatchObject({
      termination: "no-output-timeout",
      noOutputTimedOut: true,
      killed: true,
      code: null,
    });
  });

  it("the window is measured from the LAST output, to the millisecond", async () => {
    const pending = run(160);
    const child = children[0];
    await vi.advanceTimersByTimeAsync(150);
    child.stdout.emit("data", Buffer.from("."));
    await vi.advanceTimersByTimeAsync(159);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toBe(true);
    expect((await pending).termination).toBe("no-output-timeout");
  });
});
