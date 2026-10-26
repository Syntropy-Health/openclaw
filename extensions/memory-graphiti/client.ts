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

/**
 * Unified memory client interface — both self-hosted Graphiti and Zep Cloud
 * implement this so the plugin logic is backend-agnostic.
 */
export interface MemoryClient {
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
  /** Delete everything the store holds for this group (the user's forget). */
  forget(groupId: string): Promise<void>;
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

export class GraphitiRestClient implements MemoryClient {
  readonly label: string;

  constructor(private readonly serverUrl: string) {
    this.label = `graphiti-rest @ ${serverUrl}`;
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
  async forget(groupId: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/group/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Graphiti DELETE /group failed (${res.status})`);
    }
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
