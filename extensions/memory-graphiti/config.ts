import { normalizeE164 } from "openclaw/plugin-sdk";
import { DEFAULT_RANK_CONFIG, type RankConfig } from "./highlights/rank.js";
import { isCanonicalE164 } from "./tripwire.js";

export type GroupIdStrategy = "channel-sender" | "session" | "static" | "identity";

/**
 * Backend mode: "cloud" uses Zep Cloud SDK, "self-hosted" uses raw Graphiti REST API.
 * Legacy derived field, kept for backward-compat with readers of `cfg.mode`
 * (createClient's fallback path). Prefer `backend` for new code.
 */
export type BackendMode = "cloud" | "self-hosted";

/**
 * Explicit backend selection. The locked PHI posture defaults to "self-hosted".
 * QA→prod is a config swap (set backend: zep-cloud + apiKey).
 */
export type BackendType = "self-hosted" | "zep-cloud";

export type GraphitiConfig = {
  /**
   * Explicit backend. Resolution order in the parser:
   *   1. explicit `backend` wins
   *   2. else apiKey present → inferred "zep-cloud" (+ deprecationWarning)
   *   3. else default "self-hosted"
   * A parsed config ALWAYS sets this. It is optional on the type only so that
   * legacy callers passing un-parsed cfg objects (no `backend`) still typecheck
   * against createClient's backward-compat fallback.
   */
  backend?: BackendType;
  /**
   * Deprecation notice surfaced by the parser when the backend was inferred
   * implicitly from apiKey presence. config.ts has no logger, so it is carried
   * here and logged by index.ts at register().
   */
  deprecationWarning?: string;
  /** Legacy derived backend mode — preserved for `cfg.mode` readers. */
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
  /**
   * Known-synthetic / QA WhatsApp numbers (E.164). The PHI tripwire treats the
   * deployment as QA-only — and therefore lets the zep-cloud backend send data —
   * ONLY IF EVERY live WhatsApp allow-list entry is in this set. Defaults to [].
   */
  qaNumbers?: string[];
  /**
   * A RECORDED principal approval that lifts the QA-only PHI tripwire for the
   * zep-cloud backend, so real users' (minimised) chat may be stored there.
   * Absent ⇒ the QA-only tripwire applies unchanged. The approval must cite the
   * ruling verbatim, its approvals-ledger row and its date, so the rail changes
   * visibly in config and in the boot log — it never just disappears.
   */
  phiCloudApproval?: PhiCloudApproval;
  /** Auto-recall tuning (A&D §4.6). Absent: reranker "rrf", a 800 ms budget. */
  recall?: RecallConfig;
  /** Highlights (A&D §4). A parsed config always sets it, with defaults filled. */
  highlights?: HighlightsConfig;
};

export type HighlightsConfig = {
  /** Ranking constants (A&D §4.3). */
  rank: RankConfig;
  /** Summariser model, "anthropic/<id>" (D2: anthropic only). Absent: the agent default, if anthropic. */
  model?: string;
};

/** Bounds for `highlights.rank`; the manifest schema carries the same ones. */
export const RANK_HALF_LIFE_MAX_DAYS = 3650;
export const RANK_WEIGHT_MAX = 10;

export type RecallReranker = "rrf" | "mmr" | "cross_encoder";

export type RecallConfig = {
  /** Reranker for the one ranked search per turn. Default "rrf". */
  reranker?: RecallReranker;
  /**
   * Budget for that search; past it, nothing is injected. Default 800 ms. (Before
   * it existed, recall waited for the backend's own timeout: ~60 s Zep, 5 s REST.)
   */
  timeoutMs?: number;
  /** MMR relevance/diversity balance, 0..1, used only with reranker "mmr". Default 0.5. */
  mmrLambda?: number;
};

export const RECALL_TIMEOUT_MIN_MS = 50;
export const RECALL_TIMEOUT_MAX_MS = 10_000;
const VALID_RERANKERS: RecallReranker[] = ["rrf", "mmr", "cross_encoder"];

export type PhiCloudApproval = {
  /** The principal's ruling, verbatim. */
  ruling: string;
  /** The approvals ledger row that records it. */
  approvalsRow: number;
  /** YYYY-MM-DD the ruling was made. */
  date: string;
};

export type GroupIdContext = {
  sessionKey?: string;
  messageProvider?: string;
  /**
   * Verified external caller identity (e.g. the Clerk JWT `sub` for HTTP chat
   * callers); null/absent for channel callers. When present, the identity
   * strategy keys the graph on it directly so an HTTP/Clerk user shares the
   * same graph as the same person on other channels (#834/#836).
   */
  externalId?: string | null;
};

const ALLOWED_KEYS = [
  "backend",
  "apiKey",
  "serverUrl",
  "userId",
  "groupIdStrategy",
  "staticGroupId",
  "databaseUrl",
  "autoCapture",
  "autoRecall",
  "maxFacts",
  "qaNumbers",
  "phiCloudApproval",
  "recall",
  "highlights",
];

const VALID_STRATEGIES: GroupIdStrategy[] = ["channel-sender", "session", "static", "identity"];

const VALID_BACKENDS: BackendType[] = ["self-hosted", "zep-cloud"];

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
export function extractSenderFromSessionKey(sessionKey: string): string | null {
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

    // ------------------------------------------------------------------
    // Resolve backend (explicit field replaces implicit apiKey detection)
    // ------------------------------------------------------------------
    let backend: BackendType;
    let deprecationWarning: string | undefined;

    if (cfg.backend !== undefined) {
      // 1. explicit backend wins
      if (typeof cfg.backend !== "string" || !VALID_BACKENDS.includes(cfg.backend as BackendType)) {
        throw new Error(
          `backend must be one of ${VALID_BACKENDS.join(", ")} (got: ${String(cfg.backend)})`,
        );
      }
      backend = cfg.backend as BackendType;
    } else if (apiKey) {
      // 2. implicit inference from apiKey — deprecated
      backend = "zep-cloud";
      deprecationWarning =
        "memory-graphiti: implicit cloud detection from apiKey is deprecated; " +
        "set backend: zep-cloud explicitly (defaults to self-hosted otherwise)";
    } else {
      // 3. default to the locked PHI posture
      backend = "self-hosted";
    }

    // ------------------------------------------------------------------
    // Validate the resolved backend has the credential it needs
    // ------------------------------------------------------------------
    if (backend === "zep-cloud" && !apiKey) {
      // Read the env directly (NOT via ${...} in the shared openclaw.json, where a missing
      // variable fails the WHOLE gateway's config load). Missing here fails only this plugin.
      const envKey = process.env.GETZEP_API_KEY?.trim();
      if (!envKey) {
        throw new Error("backend 'zep-cloud' requires apiKey (or the GETZEP_API_KEY env var)");
      }
      apiKey = envKey;
    }
    if (backend === "self-hosted" && !serverUrl) {
      // Preserve the legacy message when nothing at all was configured, so a
      // bare {} / empty-serverUrl config still reads as "pick a backend".
      if (!apiKey && cfg.backend === undefined) {
        throw new Error(
          "Either apiKey (for Zep Cloud) or serverUrl (for self-hosted Graphiti) is required",
        );
      }
      throw new Error("backend 'self-hosted' requires serverUrl (Graphiti REST API URL)");
    }

    // Legacy derived mode, kept for backward-compat readers of cfg.mode.
    const mode: BackendMode = backend === "zep-cloud" ? "cloud" : "self-hosted";

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

    // qaNumbers (optional, default: []). Known-synthetic/QA WhatsApp numbers the
    // PHI tripwire checks senders against. They are STORED CANONICAL E.164 — each
    // raw entry is run through normalizeE164 and REJECTED if it does not
    // canonicalize to a valid E.164. This refuses raw JID / bare-non-numeric /
    // "@lid" / empty forms at parse time so the operator cannot silently weaken
    // the gate (a non-canonical stored entry would never match the canonical
    // inbound senderE164 — over-blocking — or, worse, an attacker-shaped entry
    // could under-block). normalizeE164 NEVER throws and NEVER signals
    // invalidity, so we validate the canonical form explicitly here.
    let qaNumbers: string[] = [];
    if (cfg.qaNumbers !== undefined) {
      const rawEntries: string[] = Array.isArray(cfg.qaNumbers)
        ? cfg.qaNumbers.filter((n): n is string => typeof n === "string")
        : typeof cfg.qaNumbers === "string"
          ? [cfg.qaNumbers]
          : [];
      const canonical: string[] = [];
      for (const raw of rawEntries) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          continue; // ignore empty/whitespace-only entries
        }
        const e164 = normalizeE164(trimmed);
        if (!isCanonicalE164(e164)) {
          throw new Error(
            `qaNumbers entry ${JSON.stringify(raw)} is not a valid E.164 phone number ` +
              `(canonicalized to ${JSON.stringify(e164)}). Use canonical E.164 ` +
              `(e.g. +15555550001) — raw JID, "@lid", or non-numeric forms are rejected.`,
          );
        }
        canonical.push(e164);
      }
      qaNumbers = canonical;
    }

    // phiCloudApproval (optional). Every field is REQUIRED when present: a
    // half-written approval must not lift the tripwire.
    let phiCloudApproval: PhiCloudApproval | undefined;
    if (cfg.phiCloudApproval !== undefined) {
      const a = cfg.phiCloudApproval as Record<string, unknown> | null;
      if (!a || typeof a !== "object" || Array.isArray(a)) {
        throw new Error("phiCloudApproval must be an object { ruling, approvalsRow, date }");
      }
      assertAllowedKeys(a, ["ruling", "approvalsRow", "date"], "phiCloudApproval");
      const ruling = typeof a.ruling === "string" ? a.ruling.trim() : "";
      const approvalsRow = typeof a.approvalsRow === "number" ? a.approvalsRow : NaN;
      const date = typeof a.date === "string" ? a.date.trim() : "";
      if (ruling.length < 20) {
        throw new Error("phiCloudApproval.ruling must quote the principal's ruling (>= 20 chars)");
      }
      if (!Number.isInteger(approvalsRow) || approvalsRow < 1) {
        throw new Error("phiCloudApproval.approvalsRow must be the approvals ledger row number");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("phiCloudApproval.date must be YYYY-MM-DD");
      }
      phiCloudApproval = { ruling, approvalsRow, date };
      // The approval serves REAL users, so it must partition per verified user. A fixed
      // userId or a static/session/channel strategy would pool or mis-key their memory.
      if (groupIdStrategy !== "identity" || userId !== undefined || staticGroupId) {
        throw new Error(
          "phiCloudApproval requires groupIdStrategy 'identity' with no userId/staticGroupId (per-user memory)",
        );
      }
    }

    // recall (optional): reranker + timeout budget for the per-turn ranked search.
    let recall: RecallConfig | undefined;
    if (cfg.recall !== undefined) {
      const r = cfg.recall as Record<string, unknown> | null;
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        throw new Error("recall must be an object { reranker?, timeoutMs?, mmrLambda? }");
      }
      assertAllowedKeys(r, ["reranker", "timeoutMs", "mmrLambda"], "recall");
      recall = {};
      if (r.reranker !== undefined) {
        if (!VALID_RERANKERS.includes(r.reranker as RecallReranker)) {
          throw new Error(`recall.reranker must be one of: ${VALID_RERANKERS.join(", ")}`);
        }
        recall.reranker = r.reranker as RecallReranker;
      }
      if (r.timeoutMs !== undefined) {
        const t = r.timeoutMs;
        if (
          typeof t !== "number" ||
          !Number.isInteger(t) ||
          t < RECALL_TIMEOUT_MIN_MS ||
          t > RECALL_TIMEOUT_MAX_MS
        ) {
          throw new Error(
            `recall.timeoutMs must be an integer between ${RECALL_TIMEOUT_MIN_MS} and ${RECALL_TIMEOUT_MAX_MS}`,
          );
        }
        recall.timeoutMs = t;
      }
      if (r.mmrLambda !== undefined) {
        const l = r.mmrLambda;
        if (typeof l !== "number" || !Number.isFinite(l) || l < 0 || l > 1) {
          throw new Error("recall.mmrLambda must be a number between 0 and 1");
        }
        recall.mmrLambda = l;
      }
    }

    // highlights (optional): ranking constants; absent keys take the R3 defaults.
    const rank: RankConfig = { ...DEFAULT_RANK_CONFIG };
    let highlightsModel: string | undefined;
    if (cfg.highlights !== undefined) {
      const h = cfg.highlights as Record<string, unknown> | null;
      if (!h || typeof h !== "object" || Array.isArray(h)) {
        throw new Error("highlights must be an object { rank?, model? }");
      }
      assertAllowedKeys(h, ["rank", "model"], "highlights");
      if (h.model !== undefined) {
        if (typeof h.model !== "string" || !/^anthropic\/\S+$/.test(h.model)) {
          throw new Error(
            'highlights.model must be "anthropic/<model id>" (the summariser is pinned to anthropic)',
          );
        }
        highlightsModel = h.model;
      }
      if (h.rank !== undefined) {
        const r = h.rank as Record<string, unknown> | null;
        if (!r || typeof r !== "object" || Array.isArray(r)) {
          throw new Error(
            "highlights.rank must be an object { halfLifeDays?, wOcc?, wLink?, wSal? }",
          );
        }
        assertAllowedKeys(r, ["halfLifeDays", "wOcc", "wLink", "wSal"], "highlights.rank");
        if (r.halfLifeDays !== undefined) {
          const d = r.halfLifeDays;
          if (
            typeof d !== "number" ||
            !Number.isFinite(d) ||
            d <= 0 ||
            d > RANK_HALF_LIFE_MAX_DAYS
          ) {
            throw new Error(
              `highlights.rank.halfLifeDays must be a number above 0 and at most ${RANK_HALF_LIFE_MAX_DAYS}`,
            );
          }
          rank.halfLifeDays = d;
        }
        for (const k of ["wOcc", "wLink", "wSal"] as const) {
          const w = r[k];
          if (w === undefined) {
            continue;
          }
          if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > RANK_WEIGHT_MAX) {
            throw new Error(
              `highlights.rank.${k} must be a number between 0 and ${RANK_WEIGHT_MAX}`,
            );
          }
          rank[k] = w;
        }
      }
    }

    return {
      backend,
      deprecationWarning,
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
      qaNumbers,
      phiCloudApproval,
      recall,
      highlights: highlightsModel ? { rank, model: highlightsModel } : { rank },
    };
  },

  uiHints: {
    backend: {
      label: "Backend",
      help: "Explicit memory backend. 'self-hosted' (default) uses the Graphiti REST API at serverUrl (locked PHI posture); 'zep-cloud' uses Zep Cloud with apiKey.",
    },
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
    phiCloudApproval: {
      label: "PHI cloud approval (lifts the QA-only tripwire)",
      help: "Recorded principal approval { ruling (verbatim), approvalsRow, date }. When present, the zep-cloud backend may store real users' minimised chat. Absent: QA-only.",
      advanced: true,
    },
    recall: {
      label: "Recall tuning",
      help: "{ reranker: rrf | mmr | cross_encoder (default rrf), timeoutMs (default 800 ms; past it the turn gets no facts — previously recall waited up to ~60 s on Zep, 5 s on REST), mmrLambda (0..1, default 0.5, mmr only) }.",
      advanced: true,
    },
    qaNumbers: {
      label: "QA Numbers (PHI tripwire)",
      help: "Known-synthetic/QA WhatsApp numbers (E.164). The tripwire treats the deployment as QA-only — and only then lets the zep-cloud backend send data — if EVERY live WhatsApp allow-list entry is in this set. Self-hosted is never gated.",
      advanced: true,
    },
  },
};
