/**
 * Keyless caller identity for a self-hosted graphiti-server behind Cloud Run
 * (no service-account key at rest):
 *
 *   1. the Fly machine's OIDC token (Machine API socket, POST /v1/tokens/oidc),
 *   2. exchanged at Google STS (workload identity federation) for a federated
 *      access token,
 *   3. which impersonates the invoker service account to mint a Google ID token
 *      (IAM Credentials generateIdToken) whose audience is the graphiti service URL.
 *
 * The ID token is cached until shortly before it expires. Every failure is a typed
 * MemoryBackendUnavailableError and the request is never sent unauthenticated.
 * Tokens are never logged; errors carry the step and HTTP status only.
 */
import http from "node:http";

export type GcpIdTokenConfig = {
  /** WIF provider resource: projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>. */
  wifProvider: string;
  /** The service account to impersonate (its email). */
  invokerServiceAccount: string;
  /** The ID token's audience: the graphiti service URL. */
  audience: string;
  /** The `aud` requested for the Fly OIDC token. Default: the provider's default audience. */
  oidcAudience?: string;
};

/** The memory backend cannot be called right now (no usable caller identity). */
export class MemoryBackendUnavailableError extends Error {
  readonly reason = "backend_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "MemoryBackendUnavailableError";
  }
}

export type GcpIdTokenDeps = {
  /** Returns a Fly OIDC token for `aud`. Default: the Machine API socket. */
  flyOidcToken?: (aud: string) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
};

const FLY_API_SOCKET = "/.fly/api";
const STS_URL = "https://sts.googleapis.com/v1/token";
const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1";
/** Re-mint this long before expiry, so a token never expires in flight. */
export const ID_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const STEP_TIMEOUT_MS = 10_000;
/** After a failed mint, fail fast for this long instead of re-running the chain per request. */
export const MINT_FAILURE_BACKOFF_MS = 10_000;
/** Never cache an ID token longer than this, whatever exp says. */
const MAX_TOKEN_LIFETIME_MS = 60 * 60_000;
/** The Fly OIDC reply is a JWT: anything larger is not one. */
const FLY_REPLY_MAX_BYTES = 16 * 1024;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The default allowed audience of a GCP OIDC workload identity provider. */
export function defaultOidcAudience(wifProvider: string): string {
  return `https://iam.googleapis.com/${wifProvider}`;
}

/** Decode a JWT's payload claims (no verification: Google issued it to us over TLS). */
function claims(jwt: string): { aud?: unknown; exp?: unknown } {
  const part = jwt.split(".")[1] ?? "";
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      aud?: unknown;
      exp?: unknown;
    };
  } catch {
    return {};
  }
}

/** POST /v1/tokens/oidc on the Fly Machine API socket; the body is the JWT (or {token}). */
export function flyOidcTokenFromSocket(aud: string, socketPath = FLY_API_SOCKET): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ aud });
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: "/v1/tokens/oidc",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: STEP_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > FLY_REPLY_MAX_BYTES) {
            req.destroy(new Error("too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(new MemoryBackendUnavailableError(`fly oidc token: HTTP ${res.statusCode}`));
            return;
          }
          let token = text;
          if (text.startsWith("{")) {
            try {
              token = String((JSON.parse(text) as { token?: unknown }).token ?? "");
            } catch {
              token = "";
            }
          }
          if (!JWT.test(token)) {
            reject(new MemoryBackendUnavailableError("fly oidc token: not a JWT"));
            return;
          }
          resolve(token);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    // `timeout` is an idle timeout; this bounds the whole exchange.
    const deadline = setTimeout(() => req.destroy(new Error("deadline")), STEP_TIMEOUT_MS);
    deadline.unref?.();
    req.on("close", () => clearTimeout(deadline));
    req.on("error", () =>
      reject(new MemoryBackendUnavailableError("fly oidc token: machine API unreachable")),
    );
    req.end(body);
  });
}

export function createGcpIdTokenSource(cfg: GcpIdTokenConfig, deps: GcpIdTokenDeps = {}) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const flyOidc = deps.flyOidcToken ?? ((aud: string) => flyOidcTokenFromSocket(aud));
  const oidcAudience = cfg.oidcAudience ?? defaultOidcAudience(cfg.wifProvider);
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  let failedUntil = 0;

  const post = async (step: string, url: string, init: RequestInit): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    } catch {
      throw new MemoryBackendUnavailableError(`${step}: request failed`);
    }
    if (!res.ok) {
      throw new MemoryBackendUnavailableError(`${step}: HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new MemoryBackendUnavailableError(`${step}: unreadable reply`);
    }
  };

  const mint = async (): Promise<string> => {
    const subject = await flyOidc(oidcAudience).catch((err: unknown) => {
      throw err instanceof MemoryBackendUnavailableError
        ? err
        : new MemoryBackendUnavailableError("fly oidc token: unavailable");
    });
    const sts = (await post("sts token exchange", STS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: `//iam.googleapis.com/${cfg.wifProvider}`,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        subjectToken: subject,
      }),
    })) as { access_token?: unknown };
    if (typeof sts?.access_token !== "string" || !sts.access_token) {
      throw new MemoryBackendUnavailableError("sts token exchange: no access token");
    }
    const minted = (await post(
      "generateIdToken",
      `${IAM_CREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(cfg.invokerServiceAccount)}:generateIdToken`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sts.access_token}`,
        },
        body: JSON.stringify({ audience: cfg.audience, includeEmail: true }),
      },
    )) as { token?: unknown };
    const token = typeof minted?.token === "string" ? minted.token : "";
    if (!JWT.test(token)) {
      throw new MemoryBackendUnavailableError("generateIdToken: no ID token");
    }
    const c = claims(token);
    // Never cache or send a token minted for another audience.
    if (c.aud !== cfg.audience) {
      throw new MemoryBackendUnavailableError("generateIdToken: audience mismatch");
    }
    const exp = typeof c.exp === "number" ? c.exp * 1000 : 0;
    if (exp <= now()) {
      throw new MemoryBackendUnavailableError("generateIdToken: token already expired");
    }
    cached = { token, expiresAt: Math.min(exp, now() + MAX_TOKEN_LIFETIME_MS) };
    return token;
  };

  return {
    /** A valid ID token for the configured audience; minted (single-flight) when needed. */
    async token(): Promise<string> {
      if (cached && cached.expiresAt - ID_TOKEN_REFRESH_MARGIN_MS > now()) {
        return cached.token;
      }
      cached = null;
      if (!inflight && now() < failedUntil) {
        throw new MemoryBackendUnavailableError(
          "caller identity: recent mint failed (backing off)",
        );
      }
      inflight ??= mint()
        .catch((err: unknown) => {
          failedUntil = now() + MINT_FAILURE_BACKOFF_MS;
          throw err;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

/** Environment variables for the caller identity (all non-secret resource names). */
export const GCP_ID_TOKEN_ENV = {
  wifProvider: "OPENCLAW_GRAPHITI_WIF_PROVIDER",
  invokerServiceAccount: "OPENCLAW_GRAPHITI_INVOKER_SA",
  audience: "OPENCLAW_GRAPHITI_AUDIENCE",
  oidcAudience: "OPENCLAW_GRAPHITI_OIDC_AUDIENCE",
} as const;

/**
 * The caller-identity config from the environment: null when none of the three
 * required variables is set (a local graphiti-server needs no identity). A PARTIAL
 * set is a configuration error, raised at startup rather than discovered as 403s.
 */
export function gcpIdTokenConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GcpIdTokenConfig | null {
  const get = (k: string) => env[k]?.trim() || undefined;
  const wifProvider = get(GCP_ID_TOKEN_ENV.wifProvider);
  const invokerServiceAccount = get(GCP_ID_TOKEN_ENV.invokerServiceAccount);
  const audience = get(GCP_ID_TOKEN_ENV.audience);
  const set = [wifProvider, invokerServiceAccount, audience].filter(Boolean).length;
  if (set === 0) {
    return null;
  }
  if (set < 3) {
    const missing = Object.entries({ wifProvider, invokerServiceAccount, audience })
      .filter(([, v]) => !v)
      .map(([k]) => GCP_ID_TOKEN_ENV[k as keyof typeof GCP_ID_TOKEN_ENV]);
    throw new Error(
      `memory-graphiti: caller identity is partly configured; missing ${missing.join(", ")}`,
    );
  }
  if (
    !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(
      wifProvider!,
    )
  ) {
    throw new Error(
      `memory-graphiti: ${GCP_ID_TOKEN_ENV.wifProvider} is not a provider resource name`,
    );
  }
  return {
    wifProvider: wifProvider!,
    invokerServiceAccount: invokerServiceAccount!,
    audience: audience!,
    oidcAudience: get(GCP_ID_TOKEN_ENV.oidcAudience),
  };
}

/**
 * The bearer may only go where it is meant to: when a caller identity is configured,
 * the graphiti URL must be https and on the token audience's origin. Otherwise a stale
 * or mistyped serverUrl would hand a valid ID token to another host (or the wire).
 */
export function assertIdentityTarget(serverUrl: string, audience: string): void {
  let target: URL;
  let aud: URL;
  try {
    target = new URL(serverUrl);
    aud = new URL(audience);
  } catch {
    throw new Error("memory-graphiti: serverUrl or the identity audience is not a URL");
  }
  if (target.protocol !== "https:") {
    throw new Error("memory-graphiti: a caller identity requires an https serverUrl");
  }
  if (target.origin !== aud.origin) {
    throw new Error("memory-graphiti: serverUrl is not on the identity audience's origin");
  }
}
