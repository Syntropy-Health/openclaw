/**
 * Zep Cloud client — wraps @getzep/zep-cloud SDK to implement the shared MemoryClient interface.
 * Uses Zep Cloud's managed Graphiti knowledge graph service.
 */

import { ZepClient } from "@getzep/zep-cloud";
import {
  batchText,
  buildReceipt,
  type MemoryClient,
  type FactResult,
  type EpisodeResult,
  type GraphitiMessage,
} from "./client.js";
import {
  IngestNotConfirmedError,
  textHash,
  type IngestItem,
  type MemoryReceipt,
} from "./receipts.js";

/**
 * Maps Zep Cloud userId concept to our groupId.
 * In cloud mode, groupId IS the userId.
 */
export class ZepCloudClient implements MemoryClient {
  readonly label: string;
  private readonly zep: ZepClient;

  constructor(apiKey: string) {
    this.zep = new ZepClient({ apiKey });
    this.label = "zep-cloud";
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

  /**
   * Ingest and confirm by read-back. graph.add returns the Episode it created;
   * the episode is then fetched by uuid and its content compared (sha256) with
   * exactly what was sent. A receipt exists only when they match.
   */
  async ingest(groupId: string, items: IngestItem[]): Promise<MemoryReceipt> {
    const data = batchText(items);
    let uuid: string | undefined;
    try {
      await this.ensureUser(groupId);
      const ep = await this.zep.graph.add({
        userId: groupId,
        data,
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
    let echoed: string | undefined;
    try {
      echoed = (await this.zep.graph.episode.get(uuid))?.content;
    } catch (err) {
      throw new IngestNotConfirmedError(
        `zep episode read-back failed: ${String(err)}`,
        "store_error",
      );
    }
    if (typeof echoed !== "string" || textHash(echoed) !== textHash(data)) {
      throw new IngestNotConfirmedError(
        "zep episode read-back content does not match what was sent",
        "readback_mismatch",
      );
    }
    return buildReceipt(this.label, groupId, items, [uuid]);
  }

  /** Delete the Zep user and with it the user's graph. A missing user is already forgotten. */
  async forget(groupId: string): Promise<void> {
    try {
      await this.zep.user.delete(groupId);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return;
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
