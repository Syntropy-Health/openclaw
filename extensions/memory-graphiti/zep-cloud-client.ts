/**
 * Zep Cloud client — wraps @getzep/zep-cloud SDK to implement the shared MemoryClient interface.
 * Uses Zep Cloud's managed Graphiti knowledge graph service.
 */

import { ZepClient } from "@getzep/zep-cloud";
import {
  batchText,
  type MemoryClient,
  type FactResult,
  type EpisodeResult,
  type GraphitiMessage,
  type ListFactsOptions,
  type ListFactsResult,
  type MemoryFact,
} from "./client.js";
import {
  IngestNotConfirmedError,
  textHash,
  type ConfirmResult,
  type IngestItem,
  type Submission,
} from "./receipts.js";

/** Page size for graph.edge.getByUserId. */
export const ZEP_EDGE_PAGE = 50;
/** Most edges one listFacts call reads (40 pages): bounded cost per user. */
export const ZEP_LIST_CEILING = 2_000;

type ZepEdge = {
  uuid: string;
  fact: string;
  name: string;
  createdAt: string;
  validAt?: string;
  invalidAt?: string;
  expiredAt?: string;
  episodes?: string[];
  score?: number;
};

/** SDK EntityEdge → MemoryFact (absent optional fields become null / []). */
function toMemoryFact(e: ZepEdge): MemoryFact {
  return {
    id: e.uuid,
    fact: e.fact,
    name: e.name,
    validAt: e.validAt ?? null,
    invalidAt: e.invalidAt ?? null,
    createdAt: e.createdAt,
    expiredAt: e.expiredAt ?? null,
    episodeIds: e.episodes ?? [],
  };
}

export type ZepCloudClientOptions = {
  logger?: { warn: (message: string) => void };
};

/**
 * Maps Zep Cloud userId concept to our groupId.
 * In cloud mode, groupId IS the userId.
 */
export class ZepCloudClient implements MemoryClient {
  readonly label: string;
  private readonly zep: ZepClient;
  private readonly logger: ZepCloudClientOptions["logger"];

  constructor(apiKey: string, opts: ZepCloudClientOptions = {}) {
    this.zep = new ZepClient({ apiKey });
    this.label = "zep-cloud";
    this.logger = opts.logger;
  }

  /**
   * Every fact of a user, paged with graph.edge.getByUserId (a bare page, no next
   * cursor: the cursor is the uuid of the last item read). Pages until a short or
   * empty page. Invalidated or expired facts are dropped unless includeInvalid.
   * At most ZEP_LIST_CEILING edges are read per call; stopping there with more
   * left is logged as truncated and returns a cursor to continue from.
   */
  async listFacts(groupId: string, opts: ListFactsOptions = {}): Promise<ListFactsResult> {
    const target = Math.min(opts.limit ?? ZEP_LIST_CEILING, ZEP_LIST_CEILING);
    const since = opts.since ? Date.parse(opts.since) : null;
    const facts: MemoryFact[] = [];
    let cursor = opts.cursor;
    let read = 0;
    while (facts.length < target && read < ZEP_LIST_CEILING) {
      const pageSize = Math.min(ZEP_EDGE_PAGE, target - facts.length, ZEP_LIST_CEILING - read);
      const page = (await this.zep.graph.edge.getByUserId(
        groupId,
        cursor ? { limit: pageSize, uuidCursor: cursor } : { limit: pageSize },
      )) as ZepEdge[];
      read += page.length;
      for (const edge of page) {
        cursor = edge.uuid;
        if (!opts.includeInvalid && (edge.invalidAt || edge.expiredAt)) {
          continue;
        }
        if (since !== null && Date.parse(edge.createdAt) < since) {
          continue;
        }
        facts.push(toMemoryFact(edge));
      }
      if (page.length < pageSize) {
        return { facts, nextCursor: null };
      }
    }
    // Stopped by the ceiling (not by the caller's own, lower limit): more may remain.
    const truncated = read >= ZEP_LIST_CEILING || target === ZEP_LIST_CEILING;
    if (truncated) {
      this.logger?.warn(
        `memory-graphiti: listFacts truncated at the ${ZEP_LIST_CEILING}-fact ceiling (facts=${facts.length})`,
      );
    }
    return { facts, nextCursor: cursor ?? null, ...(truncated ? { truncated } : {}) };
  }

  /**
   * Add messages to the Zep Cloud knowledge graph.
   * Uses graph.add() with type "message" for each message, or "text" for batched content.
   * Zep Cloud processes episodes synchronously (returns Episode object).
   */
  async addMessages(groupId: string, messages: GraphitiMessage[]): Promise<void> {
    // Ensure user exists (Zep Cloud requires user to exist before adding data)
    await this.ensureUser(groupId);

    // Combine all messages into a single text episode for efficient ingestion.
    // Graphiti extracts entities/relationships from the full conversation context.
    const combined = messages.map((m) => `[${m.role_type}] ${m.content}`).join("\n\n");

    await this.zep.graph.add({
      userId: groupId,
      data: combined,
      type: "message",
      sourceDescription: messages[0]?.source_description ?? "openclaw",
    });
  }

  /** graph.add returns the Episode it created; its uuid is the submission ref. */
  async submit(groupId: string, items: IngestItem[]): Promise<Submission> {
    let uuid: string | undefined;
    try {
      await this.ensureUser(groupId);
      const ep = await this.zep.graph.add({
        userId: groupId,
        data: batchText(items),
        type: "message",
        sourceDescription: "openclaw",
      });
      uuid = ep?.uuid;
    } catch (err) {
      throw new IngestNotConfirmedError(`zep graph.add failed: ${String(err)}`, "store_error");
    }
    if (!uuid) {
      throw new IngestNotConfirmedError("zep graph.add returned no episode uuid", "store_error");
    }
    return { ref: uuid };
  }

  /**
   * Read the episode back by uuid. Confirmed only when its content is exactly
   * what was sent (sha256) AND Zep reports it processed (graph extraction done);
   * a still-processing episode is "pending" and is re-checked later, never re-sent.
   */
  async confirm(
    _groupId: string,
    items: IngestItem[],
    submission: Submission,
  ): Promise<ConfirmResult> {
    let ep: { content?: string; processed?: boolean } | undefined;
    try {
      ep = await this.zep.graph.episode.get(submission.ref);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { status: "pending" }; // not visible yet
      }
      throw new IngestNotConfirmedError(
        `zep episode read-back failed: ${String(err)}`,
        "store_error",
      );
    }
    if (typeof ep?.content !== "string" || textHash(ep.content) !== textHash(batchText(items))) {
      throw new IngestNotConfirmedError(
        "zep episode read-back content does not match what was sent",
        "readback_mismatch",
      );
    }
    return ep.processed === true
      ? { status: "confirmed", episodeIds: [submission.ref] }
      : { status: "pending" };
  }

  /** Delete the Zep user and with it the user's graph. A missing user is already forgotten. */
  async forget(groupId: string): Promise<boolean> {
    try {
      await this.zep.user.delete(groupId);
      return true;
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Search for facts (entity edges) in the knowledge graph.
   * Uses graph.search() with scope "edges" to retrieve EntityEdge facts.
   */
  async searchFacts(
    query: string,
    groupIds?: string[] | null,
    maxFacts = 10,
  ): Promise<FactResult[]> {
    // Zep Cloud search uses a single userId (not an array)
    const userId = groupIds?.[0];

    const results = await this.zep.graph.search({
      query,
      userId,
      scope: "edges",
      limit: maxFacts,
    });

    const edges = results.edges ?? [];
    return edges.map((edge) => ({
      uuid: edge.uuid,
      name: edge.name,
      fact: edge.fact,
      valid_at: edge.validAt ?? null,
      invalid_at: edge.invalidAt ?? null,
      created_at: edge.createdAt,
      expired_at: edge.expiredAt ?? null,
    }));
  }

  /**
   * Retrieve recent episodes for a user/group.
   * Uses graph.episode.getByUserId() with lastN.
   */
  async getEpisodes(groupId: string, lastN = 10): Promise<EpisodeResult[]> {
    const result = await this.zep.graph.episode.getByUserId(groupId, {
      lastn: lastN,
    });

    const episodes = result.episodes ?? [];
    return episodes.map((ep) => ({
      uuid: ep.uuid,
      name: ep.sourceDescription ?? "",
      group_id: groupId,
      content: ep.content,
      created_at: ep.createdAt,
      source: ep.source ?? "message",
      source_description: ep.sourceDescription ?? "",
    }));
  }

  /**
   * Health check — attempt a lightweight API call.
   * Zep Cloud doesn't have a /healthcheck endpoint, so we use user.listOrdered with minimal results.
   */
  async healthcheck(): Promise<boolean> {
    try {
      await this.zep.user.listOrdered({ pageSize: 1, pageNumber: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure a Zep Cloud user exists for the given userId.
   * Silently succeeds if user already exists (400 "already exists" or 409).
   */
  private async ensureUser(userId: string): Promise<void> {
    try {
      await this.zep.user.add({ userId });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      const msg = String(err);
      // 400 "already exists" or 409 = user already exists, which is fine
      if (status === 409 || (status === 400 && msg.includes("already exists"))) {
        return;
      }
      throw err;
    }
  }
}
