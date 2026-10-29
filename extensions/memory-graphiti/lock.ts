/**
 * One in-process lock per memory group, shared by capture and forget: a "Clear
 * chat memory" waits for any capture of that group already under way (else its
 * late upload would survive an erase that reported SUCCEEDED), and a capture
 * that starts after the erase sees its tombstones.
 */
import type { GroupLock } from "./forget.js";

export function createGroupLock(): GroupLock {
  const tails = new Map<string, Promise<unknown>>();
  return async (groups, fn) => {
    const keys = [...new Set(groups)].sort();
    const prev = keys.map((k) => tails.get(k) ?? Promise.resolve());
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    for (const k of keys) {
      tails.set(k, mine);
    }
    await Promise.allSettled(prev);
    try {
      return await fn();
    } finally {
      release();
      for (const k of keys) {
        if (tails.get(k) === mine) {
          tails.delete(k);
        }
      }
    }
  };
}
