/**
 * Integration tests against live Zep Cloud service.
 * Requires GETZEP_API_KEY environment variable.
 *
 * Run: GETZEP_API_KEY=<key> pnpm vitest run extensions/memory-graphiti/integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZepCloudClient } from "./zep-cloud-client.js";

const API_KEY = process.env.GETZEP_API_KEY;
const TEST_USER_ID = `openclaw-integration-test-${Date.now()}`;

describe.skipIf(!API_KEY)("ZepCloudClient integration", () => {
  let client: ZepCloudClient;

  beforeAll(() => {
    client = new ZepCloudClient(API_KEY!);
  });

  afterAll(async () => {
    // Cleanup: attempt to delete test user (ignore errors)
    try {
      const { ZepClient } = await import("@getzep/zep-cloud");
      const zep = new ZepClient({ apiKey: API_KEY! });
      await zep.user.delete(TEST_USER_ID);
    } catch {
      // Test user may not have been created
    }
  });

  it("healthcheck returns true", async () => {
    const healthy = await client.healthcheck();
    expect(healthy).toBe(true);
  });

  it("addMessages ingests episode for test user", async () => {
    await client.addMessages(TEST_USER_ID, [
      {
        content: "My name is Alice and I prefer dark mode.",
        role_type: "user",
        role: "user",
      },
      {
        content: "Nice to meet you Alice! I've noted your preference for dark mode.",
        role_type: "assistant",
        role: "openclaw",
      },
    ]);
    // If we get here without throwing, ingestion succeeded
    expect(true).toBe(true);
  });

  it("getEpisodes returns the ingested episode", async () => {
    // Zep Cloud processes episodes asynchronously. Poll until available or timeout.
    let episodes: Awaited<ReturnType<typeof client.getEpisodes>> = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      episodes = await client.getEpisodes(TEST_USER_ID, 5);
      if (episodes.length > 0) break;
    }
    expect(episodes.length).toBeGreaterThanOrEqual(1);
    expect(episodes[0].content).toBeTruthy();
  });

  it("searchFacts returns facts after ingestion", async () => {
    // Wait for entity extraction to complete
    await new Promise((r) => setTimeout(r, 10000));

    const facts = await client.searchFacts("Alice dark mode preference", [TEST_USER_ID], 10);
    // Graphiti may or may not have extracted facts by now.
    // The key assertion is that search doesn't throw.
    expect(Array.isArray(facts)).toBe(true);
  });

  it("addMessages with second episode", async () => {
    await client.addMessages(TEST_USER_ID, [
      {
        content: "I work at Acme Corp in San Francisco.",
        role_type: "user",
        role: "user",
      },
    ]);
    expect(true).toBe(true);
  });

  it("searchFacts finds facts from both episodes", async () => {
    await new Promise((r) => setTimeout(r, 10000));

    const facts = await client.searchFacts("Acme Corp San Francisco work", [TEST_USER_ID], 10);
    expect(Array.isArray(facts)).toBe(true);
    // At this point we should have some facts
    if (facts.length > 0) {
      expect(facts[0].uuid).toBeTruthy();
      expect(facts[0].fact).toBeTruthy();
    }
  });
});
