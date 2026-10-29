import type { MemoryFactSurface } from "./client.js";

/** Most listFacts pages read while looking for the requested ids (bounded cost). */
const MAX_PAGES = 100;

export type OwnedForgetResult = {
  /** Owned facts the backend deleted. */
  deleted: number;
  /** Owned facts the backend no longer had (already gone between list and delete). */
  absent: number;
  /** Requested ids that are not facts of this group; never sent to the backend. */
  notOwned: number;
};

/**
 * Delete facts by id, but only those that belong to `groupId` (P2.9b).
 *
 * Zep edge ids are global and its delete takes no user, so a backend cannot refuse
 * a foreign id. Ownership is read from the group's own listing (invalidated facts
 * included, since a highlight may cite one) and only the intersection is deleted.
 * This is the one module allowed to call `forgetFacts`; a guard test enforces it.
 *
 * A backend that cannot list facts throws MemoryCapabilityError and nothing is
 * deleted. A listing that does not finish within MAX_PAGES throws, also before any
 * delete: an unproven id is never deleted.
 */
export async function forgetOwnedFacts(
  client: MemoryFactSurface,
  groupId: string,
  factIds: readonly string[],
): Promise<OwnedForgetResult> {
  const wanted = new Set(factIds);
  if (wanted.size === 0) {
    return { deleted: 0, absent: 0, notOwned: 0 };
  }

  const owned: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    if (pages++ >= MAX_PAGES) {
      throw new Error(`memory fact listing did not finish within ${MAX_PAGES} pages`);
    }
    const page = await client.listFacts(groupId, { includeInvalid: true, cursor });
    for (const f of page.facts) {
      if (wanted.has(f.id) && !owned.includes(f.id)) {
        owned.push(f.id);
      }
    }
    if (owned.length === wanted.size || !page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  const notOwned = wanted.size - owned.length;
  if (owned.length === 0) {
    return { deleted: 0, absent: 0, notOwned };
  }
  const { deleted, absent } = await client.forgetFacts(groupId, owned);
  return { deleted, absent, notOwned };
}
