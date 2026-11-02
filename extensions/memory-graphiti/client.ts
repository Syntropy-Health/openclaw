// Shared types and interface for memory backends
import {
  contentHashOf,
  entryHash,
  IngestNotConfirmedError,
  type ConfirmResult,
  type IngestItem,
  type MemoryReceipt,
  type Submission,
} from "./receipts.js";

export type FactResult = {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
  /** Source episode ids (graphiti-server FactResult carries them; absent elsewhere). */
  episodes?: string[];
};

export type EpisodeResult = {
  uuid: string;
  name: string;
  group_id: string;
  content: string;
  created_at: string;
  source: string;
  source_description: string;
};

export type GraphitiMessage = {
  content: string;
  role_type: "user" | "assistant" | "system";
  role?: string;
  name?: string;
  timestamp?: string;
  source_description?: string;
};

/** One fact (entity edge) as the read surface returns it, store-agnostic. */
export type MemoryFact = {
  id: string;
  fact: string;
  name: string;
  validAt: string | null;
  invalidAt: string | null;
  createdAt: string;
  expiredAt: string | null;
  /** Ids of the episodes the fact was derived from (may be empty). */
  episodeIds: string[];
};

export type Reranker = "rrf" | "mmr" | "cross_encoder";

/** A search hit, in the backend's rank order (rank = index + 1). */
export type RankedFact = MemoryFact & {
  rank: number;
  /** The backend's score; null when the backend reports none. */
  score: number | null;
  /**
   * Set to "server_default" when the requested reranker could not be applied and
   * the backend ranked with its own default instead (never a silent pass).
   */
  rerankerApplied?: "server_default";
};

export type ListFactsOptions = {
  /** Only facts created at or after this ISO time. */
  since?: string;
  /** At most this many facts (the backend ceiling still applies). */
  limit?: number;
  /** Continue from a previous call's nextCursor. */
  cursor?: string;
  /** Include facts that are invalidated or expired. Default false. */
  includeInvalid?: boolean;
};

export type ListFactsResult = {
  facts: MemoryFact[];
  /** Pass back as `cursor` to continue; null when everything was read. */
  nextCursor: string | null;
  /** True when the read stopped at the backend ceiling with more facts left. */
  truncated?: boolean;
};

export type SearchRankedOptions = {
  reranker: Reranker;
  limit: number;
  mmrLambda?: number;
  signal?: AbortSignal;
};

/** What a backend can actually do; the contract suite holds each client to it. */
export type MemoryCapabilities = {
  listFacts: boolean;
  forgetFacts: boolean;
  /** Rerankers the backend honours. Any other request is ranked by its default. */
  rerankers: Reranker[];
  /** Whether search results carry a backend score. */
  scores: boolean;
};

/** A backend cannot serve this operation at all (typed, never a generic error). */
export class MemoryCapabilityError extends Error {
  constructor(
    readonly reason: "backend_unsupported",
    message = "memory backend does not support this operation",
  ) {
    super(message);
    this.name = "MemoryCapabilityError";
  }
}

/**
 * The fact-level read and delete surface (A&D §4.1). Every backend implements it;
 * a backend that cannot serve an operation throws MemoryCapabilityError.
 */
export interface MemoryFactSurface {
  listFacts(groupId: string, opts?: ListFactsOptions): Promise<ListFactsResult>;
  searchRanked(groupId: string, query: string, opts: SearchRankedOptions): Promise<RankedFact[]>;
  /**
   * Delete facts by id. CALLERS MUST pass only ids of facts owned by `groupId`
   * (read from that group's own records). A backend may not be able to check
   * ownership itself: Zep edge ids are global, so a foreign id would be deleted.
   * Call it only through forgetOwnedFacts (owned-forget.ts), which checks ownership
   * first; a guard test fails if any other module calls it.
   */
  forgetFacts(groupId: string, factIds: string[]): Promise<{ deleted: number; absent: number }>;
  capabilities(): MemoryCapabilities;
}

/**
 * Unified memory client interface — both self-hosted Graphiti and Zep Cloud
 * implement this so the plugin logic is backend-agnostic.
 */
export interface MemoryClient extends MemoryFactSurface {
  addMessages(groupId: string, messages: GraphitiMessage[]): Promise<void>;
  searchFacts(query: string, groupIds?: string[] | null, maxFacts?: number): Promise<FactResult[]>;
  getEpisodes(groupId: string, lastN?: number): Promise<EpisodeResult[]>;
  healthcheck(): Promise<boolean>;
  /**
   * Hand a batch to the store. Resolves with the store's reference (Zep episode
   * uuid, or the REST batch marker) once ACCEPTED, not yet confirmed. Throws
   * IngestNotConfirmedError("store_error") if the store refused it.
   */
  submit(groupId: string, items: IngestItem[]): Promise<Submission>;
  /**
   * Check a submission by READ-BACK. "confirmed" only when the store demonstrably
   * holds exactly these items and has finished processing them; "pending" while
   * it is still processing. Throws IngestNotConfirmedError("readback_mismatch")
   * when what the store holds differs from what was sent.
   */
  confirm(groupId: string, items: IngestItem[], submission: Submission): Promise<ConfirmResult>;
  /** Delete everything the store holds for this group. True if it existed, false if already absent. */
  forget(groupId: string): Promise<boolean>;
  readonly label: string;
}

/** The text one ingest batch sends: one line block per item, role-tagged. */
export function batchText(items: IngestItem[]): string {
  return items.map((m) => `[${m.role}] ${m.text}`).join("\n\n");
}

/** Build the receipt for a confirmed batch. */
export function buildReceipt(
  store: string,
  groupId: string,
  items: IngestItem[],
  episodeIds: string[],
): MemoryReceipt {
  const entryHashes = items.map(entryHash);
  return {
    store,
    groupId,
    episodeIds,
    entryHashes,
    contentHash: contentHashOf(entryHashes),
    ingestedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Self-hosted Graphiti REST API client
// ============================================================================

const SEARCH_TIMEOUT_MS = 5_000;
const INGEST_TIMEOUT_MS = 10_000;
const HEALTHCHECK_TIMEOUT_MS = 3_000;

export type GraphitiRestClientOptions = {
  /** Transport for the fact surface (tests pass an HTTP fixture). Default: global fetch. */
  fetch?: typeof fetch;
};

/** FactResult (snake_case, graphiti-server) → MemoryFact. */
function factFromResult(f: FactResult): MemoryFact {
  return {
    id: f.uuid,
    fact: f.fact,
    name: f.name,
    validAt: f.valid_at ?? null,
    invalidAt: f.invalid_at ?? null,
    createdAt: f.created_at,
    expiredAt: f.expired_at ?? null,
    episodeIds: f.episodes ?? [],
  };
}

/** Page size for GET /groups/{group_id}/entity-edges (our server overlay, mono #598). */
export const GRAPHITI_EDGE_PAGE = 50;
/** Most edges one listFacts call reads (40 pages): the same bound as Zep's. */
export const GRAPHITI_LIST_CEILING = 2_000;
const LIST_TIMEOUT_MS = 10_000;
/** One listFacts call, all pages: under the 120 s regeneration lease. */
const LIST_DEADLINE_MS = 90_000;

type EdgePage = { facts: FactResult[]; next_cursor: string | null };

export class GraphitiRestClient implements MemoryClient {
  readonly label: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly serverUrl: string,
    opts: GraphitiRestClientOptions = {},
  ) {
    this.label = `graphiti-rest @ ${serverUrl}`;
    // Resolved per call, so a test that stubs the global fetch still applies.
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * /search takes no reranker and returns no score (CTO #17028 (b)). Facts are
   * listed through our server overlay's paged route (mono #598): upstream
   * graphiti-server has no list-edges route of its own.
   */
  capabilities(): MemoryCapabilities {
    return { listFacts: true, forgetFacts: true, rerankers: ["rrf"], scores: false };
  }

  /**
   * Every fact of the group through GET /groups/{group_id}/entity-edges, in uuid
   * order (keyset pages of GRAPHITI_EDGE_PAGE; uuids are random, so this order is
   * NOT by age). The
   * invalid and `since` filters apply after paging, so they never end it early. At
   * most GRAPHITI_LIST_CEILING edges are read per call; stopping there with more
   * left is reported as truncated, with a cursor to continue from. A server reply
   * that breaks the paging contract (an empty page that claims more; a cursor that is
   * not the page's last uuid; uuids not strictly descending below the cursor) is an
   * error: never a partial list that looks complete. A server without the route
   * (404/405: an image older than the overlay) is backend_unsupported, as before.
   */
  async listFacts(groupId: string, opts: ListFactsOptions = {}): Promise<ListFactsResult> {
    const target = Math.min(opts.limit ?? GRAPHITI_LIST_CEILING, GRAPHITI_LIST_CEILING);
    if (!(target > 0)) {
      throw new RangeError(`listFacts limit must be a positive number (got ${opts.limit})`);
    }
    const deadline = AbortSignal.timeout(LIST_DEADLINE_MS);
    const since = opts.since ? Date.parse(opts.since) : null;
    const facts: MemoryFact[] = [];
    let cursor: string | null = opts.cursor ?? null;
    let read = 0;
    while (facts.length < target && read < GRAPHITI_LIST_CEILING) {
      const pageSize = Math.min(
        GRAPHITI_EDGE_PAGE,
        target - facts.length,
        GRAPHITI_LIST_CEILING - read,
      );
      const url = new URL(`${this.serverUrl}/groups/${encodeURIComponent(groupId)}/entity-edges`);
      url.searchParams.set("limit", String(pageSize));
      if (cursor !== null) {
        url.searchParams.set("cursor", cursor);
      }
      const res = await this.fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(LIST_TIMEOUT_MS)]),
      });
      if (res.status === 404 || res.status === 405) {
        // The route is ours (overlay); an empty group is 200 with no facts, never 404.
        throw new MemoryCapabilityError(
          "backend_unsupported",
          "graphiti-server has no entity-edges route (image older than the overlay)",
        );
      }
      if (!res.ok) {
        throw new Error(`graphiti-server GET /groups/{id}/entity-edges failed (${res.status})`);
      }
      const page = (await res.json()) as EdgePage;
      if (!Array.isArray(page?.facts)) {
        throw new Error("graphiti-server entity-edges reply has no facts array");
      }
      const next = page.next_cursor ?? null;
      let previous = cursor;
      for (const f of page.facts) {
        if (typeof f?.uuid !== "string" || (previous !== null && !(f.uuid < previous))) {
          throw new Error("graphiti-server entity-edges reply broke the paging contract");
        }
        previous = f.uuid;
      }
      if (next !== null && (page.facts.length === 0 || next !== page.facts.at(-1)?.uuid)) {
        throw new Error("graphiti-server entity-edges reply broke the paging contract");
      }
      read += page.facts.length;
      for (const f of page.facts) {
        if (!opts.includeInvalid && (f.invalid_at || f.expired_at)) {
          continue;
        }
        if (since !== null && Date.parse(f.created_at) < since) {
          continue;
        }
        facts.push(factFromResult(f));
      }
      cursor = next;
      if (cursor === null) {
        return { facts, nextCursor: null };
      }
    }
    // More remains. Truncated when the ceiling stopped us, not the caller's own limit.
    const truncated = read >= GRAPHITI_LIST_CEILING || target === GRAPHITI_LIST_CEILING;
    return { facts, nextCursor: cursor, ...(truncated ? { truncated } : {}) };
  }

  /**
   * POST /search. The server ranks with its library default (hybrid + RRF) and
   * returns no score, so score is null; a requested reranker other than rrf is
   * reported as `rerankerApplied: "server_default"`, never silently honoured.
   */
  async searchRanked(
    groupId: string,
    query: string,
    opts: SearchRankedOptions,
  ): Promise<RankedFact[]> {
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const res = await this.fetchImpl(`${this.serverUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_ids: [groupId], query, max_facts: opts.limit }),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Graphiti POST /search failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { facts?: FactResult[] };
    const fallback = opts.reranker === "rrf" ? {} : { rerankerApplied: "server_default" as const };
    return (data.facts ?? []).map((f, i) => ({
      ...factFromResult(f),
      rank: i + 1,
      score: null,
      ...fallback,
    }));
  }

  /** DELETE /entity-edge/{uuid} per id: 200 deleted, 404 absent, anything else throws. */
  async forgetFacts(
    _groupId: string,
    factIds: string[],
  ): Promise<{ deleted: number; absent: number }> {
    let deleted = 0;
    let absent = 0;
    for (const id of new Set(factIds)) {
      const res = await this.fetchImpl(`${this.serverUrl}/entity-edge/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
      });
      if (res.status === 404) {
        absent++;
      } else if (res.ok) {
        deleted++;
      } else {
        throw new Error(`Graphiti DELETE /entity-edge failed (${res.status})`);
      }
    }
    return { deleted, absent };
  }

  /**
   * POST /messages is asynchronous (202, no ids). Each batch carries a unique
   * marker in source_description; that marker is the submission ref.
   */
  async submit(groupId: string, items: IngestItem[]): Promise<Submission> {
    const ref = `openclaw:receipt:${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    try {
      await this.addMessages(
        groupId,
        items.map((m) => ({
          content: m.text,
          role_type: m.role,
          role: m.role === "assistant" ? "openclaw" : "user",
          timestamp,
          source_description: ref,
        })),
      );
    } catch (err) {
      throw new IngestNotConfirmedError(
        `graphiti POST /messages failed: ${String(err)}`,
        "store_error",
      );
    }
    return { ref };
  }

  /**
   * Read-back: the episodes carrying this batch's marker must hold every item
   * EXACTLY (the message text, optionally "role: " prefixed), not merely contain
   * it as a substring. INFERRED until checked against a live server: Graphiti
   * stores source_description verbatim and one episode per message.
   */
  async confirm(
    groupId: string,
    items: IngestItem[],
    submission: Submission,
  ): Promise<ConfirmResult> {
    const eps = (await this.getEpisodes(groupId, Math.max(20, items.length * 2))).filter(
      (e) => e.source_description === submission.ref,
    );
    const holds = (e: EpisodeResult, m: IngestItem) =>
      e.content === m.text || e.content === `${m.role}: ${m.text}`;
    if (items.every((m) => eps.some((e) => holds(e, m)))) {
      return { status: "confirmed", episodeIds: eps.map((e) => e.uuid) };
    }
    return { status: "pending" };
  }

  /** DELETE /group/{group_id}. INFERRED endpoint; verify on a live server. */
  async forget(groupId: string): Promise<boolean> {
    const res = await fetch(`${this.serverUrl}/group/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return false;
    }
    if (!res.ok) {
      throw new Error(`Graphiti DELETE /group failed (${res.status})`);
    }
    return true;
  }

  /**
   * Ingest messages into Graphiti's knowledge graph.
   * POST /messages — returns 202 Accepted (async processing).
   */
  async addMessages(groupId: string, messages: GraphitiMessage[]): Promise<void> {
    const res = await fetch(`${this.serverUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId, messages }),
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });

    if (!res.ok && res.status !== 202) {
      const body = await res.text().catch(() => "");
      throw new Error(`Graphiti POST /messages failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }

  /**
   * Search for facts (entity edges) in the knowledge graph.
   * POST /search — returns facts array.
   */
  async searchFacts(
    query: string,
    groupIds?: string[] | null,
    maxFacts = 10,
  ): Promise<FactResult[]> {
    const res = await fetch(`${this.serverUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        group_ids: groupIds ?? null,
        max_facts: maxFacts,
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Graphiti POST /search failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { facts?: FactResult[] };
    return data.facts ?? [];
  }

  /**
   * Retrieve recent episodes for a group.
   * GET /episodes/{group_id}?last_n={lastN}
   */
  async getEpisodes(groupId: string, lastN = 10): Promise<EpisodeResult[]> {
    const url = `${this.serverUrl}/episodes/${encodeURIComponent(groupId)}?last_n=${lastN}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Graphiti GET /episodes/${groupId} failed (${res.status}): ${body.slice(0, 200)}`,
      );
    }

    return (await res.json()) as EpisodeResult[];
  }

  /**
   * Health check against the Graphiti server.
   * GET /healthcheck — returns true if server responds with 200.
   */
  async healthcheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/healthcheck`, {
        signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
