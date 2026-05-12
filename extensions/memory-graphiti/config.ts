export type GroupIdStrategy = "channel-sender" | "session" | "static" | "identity";

/**
 * Backend mode: "cloud" uses Zep Cloud SDK, "self-hosted" uses raw Graphiti REST API.
 * Auto-detected from config: if apiKey is present → cloud, else → self-hosted.
 */
export type BackendMode = "cloud" | "self-hosted";

export type GraphitiConfig = {
  /** Backend mode — auto-detected from apiKey / serverUrl presence. */
  mode: BackendMode;
  /** Zep Cloud API key (cloud mode). Supports ${GETZEP_API_KEY}. */
  apiKey?: string;
  /** Self-hosted Graphiti REST API URL (self-hosted mode). */
  serverUrl?: string;
  /** User ID for Zep Cloud graph partitioning. Falls back to groupId derivation. */
  userId?: string;
  groupIdStrategy: GroupIdStrategy;
  staticGroupId?: string;
  /**
   * PostgreSQL connection URL for identity-based group_id resolution.
   * Required when groupIdStrategy is "identity". Reads user identity from
   * lp_users + lp_user_channels tables (created by persist-user-identity).
   * Falls back to DATABASE_URL env var.
   */
  databaseUrl?: string;
  autoCapture: boolean;
  autoRecall: boolean;
  maxFacts: number;
};

export type GroupIdContext = {
  sessionKey?: string;
  messageProvider?: string;
};

const ALLOWED_KEYS = [
  "apiKey",
  "serverUrl",
  "userId",
  "groupIdStrategy",
  "staticGroupId",
  "databaseUrl",
  "autoCapture",
  "autoRecall",
  "maxFacts",
];

const VALID_STRATEGIES: GroupIdStrategy[] = ["channel-sender", "session", "static", "identity"];

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

// Normalize server URL: strip trailing slash
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Extract sender ID from session key.
 * Session key format: `agent:<agentId>:<channel>:<type>:<peerId>`
 * We take the last segment as the sender identifier.
 */
function extractSenderFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") {
    return null;
  }
  // Last segment is typically the peer/sender ID
  return parts[parts.length - 1] ?? null;
}

/**
 * Derive Graphiti group_id (or Zep Cloud userId) from hook context and config strategy.
 */
export function deriveGroupId(ctx: GroupIdContext, cfg: GraphitiConfig): string {
  switch (cfg.groupIdStrategy) {
    case "static":
      return cfg.staticGroupId ?? "default";

    case "session":
      return ctx.sessionKey ?? "default";

    // Identity strategy: synchronous fallback only. Actual identity
    // resolution is async (DB query) and handled in the hook caller.
    // This branch is reached when the async resolver returns null.
    case "identity":
    case "channel-sender": {
      const provider = ctx.messageProvider;
      const sessionKey = ctx.sessionKey;

      if (provider && sessionKey) {
        const sender = extractSenderFromSessionKey(sessionKey);
        if (sender) {
          return `${provider}:${sender}`;
        }
      }

      // Fallback: use raw sessionKey or default
      return sessionKey ?? "default";
    }
  }
}

export const graphitiConfigSchema = {
  parse(value: unknown): GraphitiConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-graphiti config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "memory-graphiti config");

    // Resolve apiKey (supports ${GETZEP_API_KEY})
    let apiKey: string | undefined;
    if (typeof cfg.apiKey === "string" && cfg.apiKey.trim()) {
      apiKey = resolveEnvVars(cfg.apiKey);
    }

    // Resolve serverUrl
    let serverUrl: string | undefined;
    if (typeof cfg.serverUrl === "string" && cfg.serverUrl.trim()) {
      serverUrl = normalizeUrl(resolveEnvVars(cfg.serverUrl));
    }

    // Require at least one backend
    if (!apiKey && !serverUrl) {
      throw new Error(
        "Either apiKey (for Zep Cloud) or serverUrl (for self-hosted Graphiti) is required",
      );
    }

    // Auto-detect mode
    const mode: BackendMode = apiKey ? "cloud" : "self-hosted";

    // userId (optional, cloud mode)
    const userId = typeof cfg.userId === "string" ? cfg.userId.trim() || undefined : undefined;

    // groupIdStrategy (optional, default: "channel-sender")
    const rawStrategy = cfg.groupIdStrategy;
    const groupIdStrategy: GroupIdStrategy =
      typeof rawStrategy === "string" && VALID_STRATEGIES.includes(rawStrategy as GroupIdStrategy)
        ? (rawStrategy as GroupIdStrategy)
        : "channel-sender";

    // staticGroupId (required when strategy is "static")
    const staticGroupId =
      typeof cfg.staticGroupId === "string" ? cfg.staticGroupId.trim() : undefined;
    if (groupIdStrategy === "static" && !staticGroupId) {
      throw new Error("staticGroupId is required when groupIdStrategy is 'static'");
    }

    // databaseUrl (required for identity strategy, falls back to DATABASE_URL env)
    let databaseUrl: string | undefined;
    if (typeof cfg.databaseUrl === "string" && cfg.databaseUrl.trim()) {
      databaseUrl = resolveEnvVars(cfg.databaseUrl);
    } else if (groupIdStrategy === "identity") {
      databaseUrl = process.env.DATABASE_URL;
    }
    if (groupIdStrategy === "identity" && !databaseUrl) {
      throw new Error(
        "databaseUrl (or DATABASE_URL env) is required when groupIdStrategy is 'identity'",
      );
    }

    // maxFacts (optional, default: 10)
    const maxFacts = typeof cfg.maxFacts === "number" ? Math.floor(cfg.maxFacts) : 10;
    if (maxFacts < 1 || maxFacts > 100) {
      throw new Error("maxFacts must be between 1 and 100");
    }

    return {
      mode,
      apiKey,
      serverUrl,
      userId,
      groupIdStrategy,
      staticGroupId,
      databaseUrl,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      maxFacts,
    };
  },

  uiHints: {
    apiKey: {
      label: "Zep Cloud API Key",
      sensitive: true,
      placeholder: "${GETZEP_API_KEY}",
      help: "Zep Cloud API key. When set, uses Zep Cloud instead of self-hosted Graphiti.",
    },
    serverUrl: {
      label: "Graphiti Server URL",
      placeholder: "http://localhost:8000",
      help: "URL of your self-hosted Graphiti REST API server. Used when apiKey is not set.",
    },
    userId: {
      label: "Zep Cloud User ID",
      placeholder: "auto-derived from groupId",
      help: "Fixed Zep Cloud user ID. If not set, derived from group ID strategy.",
      advanced: true,
    },
    groupIdStrategy: {
      label: "Group ID Strategy",
      help: "How to partition the knowledge graph",
    },
    staticGroupId: {
      label: "Static Group ID",
      placeholder: "main",
      advanced: true,
    },
    databaseUrl: {
      label: "Identity Database URL",
      sensitive: true,
      placeholder: "postgresql://user:pass@host:5432/db",
      help: "PostgreSQL URL for identity resolution (persist-user-identity tables). Required for 'identity' strategy. Falls back to DATABASE_URL env.",
      advanced: true,
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture conversations into the knowledge graph",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant facts before each agent turn",
    },
    maxFacts: {
      label: "Max Facts",
      placeholder: "10",
      advanced: true,
    },
  },
};
