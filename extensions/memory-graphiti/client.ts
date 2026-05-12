// Shared types and interface for memory backends

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
  readonly label: string;
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
