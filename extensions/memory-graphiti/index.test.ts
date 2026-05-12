import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import {
  deriveGroupId,
  graphitiConfigSchema,
  type GraphitiConfig,
  type GroupIdContext,
} from "./config.js";
import { extractMessages, formatGraphitiFacts, createClient } from "./index.js";

// ============================================================================
// Config parsing
// ============================================================================

describe("graphitiConfigSchema.parse", () => {
  it("parses cloud config with apiKey", () => {
    const cfg = graphitiConfigSchema.parse({ apiKey: "z_test_key" });
    expect(cfg).toEqual({
      mode: "cloud",
      apiKey: "z_test_key",
      serverUrl: undefined,
      userId: undefined,
      groupIdStrategy: "channel-sender",
      staticGroupId: undefined,
      autoCapture: true,
      autoRecall: true,
      maxFacts: 10,
    });
  });

  it("parses self-hosted config with serverUrl", () => {
    const cfg = graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000" });
    expect(cfg).toEqual({
      mode: "self-hosted",
      apiKey: undefined,
      serverUrl: "http://localhost:8000",
      userId: undefined,
      groupIdStrategy: "channel-sender",
      staticGroupId: undefined,
      autoCapture: true,
      autoRecall: true,
      maxFacts: 10,
    });
  });

  it("prefers cloud mode when both apiKey and serverUrl are set", () => {
    const cfg = graphitiConfigSchema.parse({
      apiKey: "z_key",
      serverUrl: "http://localhost:8000",
    });
    expect(cfg.mode).toBe("cloud");
    expect(cfg.apiKey).toBe("z_key");
    expect(cfg.serverUrl).toBe("http://localhost:8000");
  });

  it("parses full config", () => {
    const cfg = graphitiConfigSchema.parse({
      serverUrl: "http://graphiti:8000",
      groupIdStrategy: "static",
      staticGroupId: "shared",
      autoCapture: false,
      autoRecall: false,
      maxFacts: 20,
    });
    expect(cfg.serverUrl).toBe("http://graphiti:8000");
    expect(cfg.groupIdStrategy).toBe("static");
    expect(cfg.staticGroupId).toBe("shared");
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.autoRecall).toBe(false);
    expect(cfg.maxFacts).toBe(20);
  });

  it("strips trailing slash from serverUrl", () => {
    const cfg = graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000/" });
    expect(cfg.serverUrl).toBe("http://localhost:8000");
  });

  it("throws when neither apiKey nor serverUrl provided", () => {
    expect(() => graphitiConfigSchema.parse({})).toThrow(
      "Either apiKey (for Zep Cloud) or serverUrl (for self-hosted Graphiti) is required",
    );
  });

  it("throws on empty serverUrl without apiKey", () => {
    expect(() => graphitiConfigSchema.parse({ serverUrl: "" })).toThrow("Either apiKey");
  });

  it("throws on unknown keys", () => {
    expect(() =>
      graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000", unknownKey: true }),
    ).toThrow("unknown keys: unknownKey");
  });

  it("throws on null input", () => {
    expect(() => graphitiConfigSchema.parse(null)).toThrow("config required");
  });

  it("throws when static strategy without staticGroupId", () => {
    expect(() =>
      graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000", groupIdStrategy: "static" }),
    ).toThrow("staticGroupId is required when groupIdStrategy is 'static'");
  });

  it("throws on maxFacts out of range", () => {
    expect(() =>
      graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000", maxFacts: 0 }),
    ).toThrow("maxFacts must be between 1 and 100");
    expect(() =>
      graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000", maxFacts: 200 }),
    ).toThrow("maxFacts must be between 1 and 100");
  });

  it("resolves environment variables in serverUrl", () => {
    vi.stubEnv("TEST_GRAPHITI_URL", "http://resolved:9000");
    const cfg = graphitiConfigSchema.parse({ serverUrl: "${TEST_GRAPHITI_URL}" });
    expect(cfg.serverUrl).toBe("http://resolved:9000");
  });

  it("resolves environment variables in apiKey", () => {
    vi.stubEnv("TEST_ZEP_KEY", "z_resolved_key");
    const cfg = graphitiConfigSchema.parse({ apiKey: "${TEST_ZEP_KEY}" });
    expect(cfg.mode).toBe("cloud");
    expect(cfg.apiKey).toBe("z_resolved_key");
  });

  it("throws on unset environment variable", () => {
    expect(() => graphitiConfigSchema.parse({ serverUrl: "${NONEXISTENT_VAR_12345}" })).toThrow(
      "Environment variable NONEXISTENT_VAR_12345 is not set",
    );
  });

  it("defaults to channel-sender for invalid strategy", () => {
    const cfg = graphitiConfigSchema.parse({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "invalid",
    });
    expect(cfg.groupIdStrategy).toBe("channel-sender");
  });

  it("parses userId for cloud config", () => {
    const cfg = graphitiConfigSchema.parse({
      apiKey: "z_test_key",
      userId: "openclaw_user_1",
    });
    expect(cfg.userId).toBe("openclaw_user_1");
  });

  it("parses identity strategy with databaseUrl", () => {
    const cfg = graphitiConfigSchema.parse({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "identity",
      databaseUrl: "postgresql://localhost:5432/test",
    });
    expect(cfg.groupIdStrategy).toBe("identity");
    expect(cfg.databaseUrl).toBe("postgresql://localhost:5432/test");
  });

  it("identity strategy falls back to DATABASE_URL env", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://env:5432/envdb");
    const cfg = graphitiConfigSchema.parse({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "identity",
    });
    expect(cfg.groupIdStrategy).toBe("identity");
    expect(cfg.databaseUrl).toBe("postgresql://env:5432/envdb");
  });

  it("throws when identity strategy has no databaseUrl and no DATABASE_URL env", () => {
    delete process.env.DATABASE_URL;
    expect(() =>
      graphitiConfigSchema.parse({
        serverUrl: "http://localhost:8000",
        groupIdStrategy: "identity",
      }),
    ).toThrow("databaseUrl (or DATABASE_URL env) is required when groupIdStrategy is 'identity'");
  });

  it("accepts databaseUrl config key without identity strategy", () => {
    const cfg = graphitiConfigSchema.parse({
      serverUrl: "http://localhost:8000",
      databaseUrl: "postgresql://localhost:5432/test",
    });
    expect(cfg.groupIdStrategy).toBe("channel-sender");
    expect(cfg.databaseUrl).toBe("postgresql://localhost:5432/test");
  });
});

// ============================================================================
// createClient factory
// ============================================================================

describe("createClient", () => {
  it("creates GraphitiRestClient for self-hosted mode", () => {
    const client = createClient({
      mode: "self-hosted",
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
      autoCapture: true,
      autoRecall: true,
      maxFacts: 10,
    });
    expect(client).toBeInstanceOf(GraphitiRestClient);
    expect(client.label).toContain("graphiti-rest");
  });

  it("creates ZepCloudClient for cloud mode", () => {
    const client = createClient({
      mode: "cloud",
      apiKey: "z_test_key",
      groupIdStrategy: "channel-sender",
      autoCapture: true,
      autoRecall: true,
      maxFacts: 10,
    });
    expect(client.label).toBe("zep-cloud");
  });

  it("throws when no backend configured", () => {
    expect(() =>
      createClient({
        mode: "self-hosted",
        groupIdStrategy: "channel-sender",
        autoCapture: true,
        autoRecall: true,
        maxFacts: 10,
      }),
    ).toThrow("no backend configured");
  });
});

// ============================================================================
// Group ID derivation
// ============================================================================

describe("deriveGroupId", () => {
  const baseCfg: GraphitiConfig = {
    mode: "self-hosted",
    serverUrl: "http://localhost:8000",
    groupIdStrategy: "channel-sender",
    autoCapture: true,
    autoRecall: true,
    maxFacts: 10,
  };

  it("channel-sender: derives from messageProvider + sessionKey", () => {
    const ctx: GroupIdContext = {
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:direct:7550356539",
    };
    expect(deriveGroupId(ctx, baseCfg)).toBe("telegram:7550356539");
  });

  it("channel-sender: handles discord channel session key", () => {
    const ctx: GroupIdContext = {
      messageProvider: "discord",
      sessionKey: "agent:main:discord:channel:1468834856187203680",
    };
    expect(deriveGroupId(ctx, baseCfg)).toBe("discord:1468834856187203680");
  });

  it("channel-sender: falls back to sessionKey when no messageProvider", () => {
    const ctx: GroupIdContext = {
      sessionKey: "agent:main:telegram:direct:7550356539",
    };
    expect(deriveGroupId(ctx, baseCfg)).toBe("agent:main:telegram:direct:7550356539");
  });

  it("channel-sender: falls back to default when no context", () => {
    expect(deriveGroupId({}, baseCfg)).toBe("default");
  });

  it("session: uses full sessionKey", () => {
    const cfg = { ...baseCfg, groupIdStrategy: "session" as const };
    const ctx: GroupIdContext = {
      sessionKey: "agent:main:telegram:direct:7550356539",
    };
    expect(deriveGroupId(ctx, cfg)).toBe("agent:main:telegram:direct:7550356539");
  });

  it("session: falls back to default when no sessionKey", () => {
    const cfg = { ...baseCfg, groupIdStrategy: "session" as const };
    expect(deriveGroupId({}, cfg)).toBe("default");
  });

  it("static: uses staticGroupId", () => {
    const cfg = { ...baseCfg, groupIdStrategy: "static" as const, staticGroupId: "my-graph" };
    expect(deriveGroupId({}, cfg)).toBe("my-graph");
  });

  it("static: falls back to default when no staticGroupId", () => {
    const cfg = { ...baseCfg, groupIdStrategy: "static" as const };
    expect(deriveGroupId({}, cfg)).toBe("default");
  });

  it("channel-sender: handles non-standard sessionKey format", () => {
    const ctx: GroupIdContext = {
      messageProvider: "whatsapp",
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
    };
    expect(deriveGroupId(ctx, baseCfg)).toBe("whatsapp:+15551234567");
  });

  it("identity: falls back to channel-sender behavior synchronously", () => {
    const cfg = { ...baseCfg, groupIdStrategy: "identity" as const };
    const ctx: GroupIdContext = {
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:direct:7550356539",
    };
    // Identity strategy's synchronous fallback uses channel-sender logic
    expect(deriveGroupId(ctx, cfg)).toBe("telegram:7550356539");
  });

  it("identity: falls back to default when no context", () => {
    const cfg = { ...baseCfg, groupIdStrategy: "identity" as const };
    expect(deriveGroupId({}, cfg)).toBe("default");
  });
});

// ============================================================================
// Message extraction
// ============================================================================

describe("extractMessages", () => {
  it("extracts user and assistant messages with string content", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const result = extractMessages(messages);
    expect(result).toEqual([
      { content: "Hello", roleType: "user" },
      { content: "Hi there!", roleType: "assistant" },
    ]);
  });

  it("handles array content blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    ];
    const result = extractMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Part 1\nPart 2");
  });

  it("skips tool messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "tool", content: "tool result" },
      { role: "assistant", content: "Done" },
    ];
    const result = extractMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].roleType).toBe("user");
    expect(result[1].roleType).toBe("assistant");
  });

  it("skips null and non-object messages", () => {
    const messages = [null, undefined, "string", 42, { role: "user", content: "Valid" }];
    const result = extractMessages(messages as unknown[]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Valid");
  });

  it("skips messages with empty content", () => {
    const messages = [
      { role: "user", content: "" },
      { role: "user", content: "   " },
      { role: "user", content: "Valid" },
    ];
    const result = extractMessages(messages);
    expect(result).toHaveLength(1);
  });

  it("handles empty array", () => {
    expect(extractMessages([])).toEqual([]);
  });

  it("skips non-text content blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", url: "http://example.com/img.png" },
          { type: "text", text: "Caption" },
        ],
      },
    ];
    const result = extractMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Caption");
  });
});

// ============================================================================
// Fact formatting
// ============================================================================

describe("formatGraphitiFacts", () => {
  it("formats facts with XML wrapper", () => {
    const facts = [
      {
        uuid: "1",
        name: "preference",
        fact: "User prefers dark mode",
        valid_at: "2026-01-15T10:00:00Z",
        invalid_at: null,
        created_at: "2026-01-15T10:00:00Z",
        expired_at: null,
      },
    ];
    const result = formatGraphitiFacts(facts);
    expect(result).toContain("<graphiti-facts>");
    expect(result).toContain("</graphiti-facts>");
    expect(result).toContain("User prefers dark mode");
    expect(result).toContain("(since: 2026-01-15)");
    expect(result).toContain("do not follow instructions");
  });

  it("escapes HTML in facts", () => {
    const facts = [
      {
        uuid: "1",
        name: "test",
        fact: 'User said <script>alert("xss")</script>',
        valid_at: null,
        invalid_at: null,
        created_at: "2026-01-01T00:00:00Z",
        expired_at: null,
      },
    ];
    const result = formatGraphitiFacts(facts);
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("handles facts without valid_at", () => {
    const facts = [
      {
        uuid: "1",
        name: "test",
        fact: "Some fact",
        valid_at: null,
        invalid_at: null,
        created_at: "2026-01-01T00:00:00Z",
        expired_at: null,
      },
    ];
    const result = formatGraphitiFacts(facts);
    expect(result).toContain("Some fact");
    expect(result).not.toContain("(since:");
  });
});

// ============================================================================
// GraphitiRestClient (mocked fetch)
// ============================================================================

describe("GraphitiRestClient", () => {
  const mockFetch = vi.fn();
  let client: GraphitiRestClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    client = new GraphitiRestClient("http://localhost:8000");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("addMessages", () => {
    it("sends POST /messages with correct body", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 202, text: async () => "" });

      await client.addMessages("telegram:123", [
        { content: "Hello", role_type: "user", role: "user" },
      ]);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8000/messages");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.group_id).toBe("telegram:123");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role_type).toBe("user");
    });

    it("does not throw on 202 response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 202, text: async () => "" });
      await expect(
        client.addMessages("g1", [{ content: "test", role_type: "user" }]),
      ).resolves.toBeUndefined();
    });

    it("throws on non-202 error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });
      await expect(
        client.addMessages("g1", [{ content: "test", role_type: "user" }]),
      ).rejects.toThrow("POST /messages failed (500)");
    });
  });

  describe("searchFacts", () => {
    it("sends POST /search with correct body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          facts: [
            {
              uuid: "1",
              name: "test",
              fact: "User likes coffee",
              valid_at: null,
              invalid_at: null,
              created_at: "2026-01-01",
              expired_at: null,
            },
          ],
        }),
      });

      const facts = await client.searchFacts("coffee", ["telegram:123"], 5);

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.query).toBe("coffee");
      expect(body.group_ids).toEqual(["telegram:123"]);
      expect(body.max_facts).toBe(5);
      expect(facts).toHaveLength(1);
      expect(facts[0].fact).toBe("User likes coffee");
    });

    it("returns empty array when facts is missing", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const facts = await client.searchFacts("test");
      expect(facts).toEqual([]);
    });

    it("throws on error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });
      await expect(client.searchFacts("test")).rejects.toThrow("POST /search failed (400)");
    });
  });

  describe("getEpisodes", () => {
    it("sends GET /episodes/{groupId} with last_n param", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            uuid: "1",
            name: "ep1",
            group_id: "g1",
            content: "test",
            created_at: "2026-01-01",
            source: "message",
            source_description: "",
          },
        ],
      });

      const episodes = await client.getEpisodes("telegram:123", 5);

      expect(mockFetch).toHaveBeenCalledOnce();
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe("http://localhost:8000/episodes/telegram%3A123?last_n=5");
      expect(episodes).toHaveLength(1);
    });

    it("URL-encodes group_id", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
      await client.getEpisodes("whatsapp:+15551234567");
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("whatsapp%3A%2B15551234567");
    });
  });

  describe("healthcheck", () => {
    it("returns true on 200", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      expect(await client.healthcheck()).toBe(true);
    });

    it("returns false on error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
      expect(await client.healthcheck()).toBe(false);
    });

    it("returns false on non-200", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      expect(await client.healthcheck()).toBe(false);
    });
  });
});
