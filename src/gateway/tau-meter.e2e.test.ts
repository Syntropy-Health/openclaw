/**
 * SEALED challenge suite — Phase C (τ-metering) HTTP wiring, contract §9.
 *
 * Category: integration/tau-meter
 *
 * Proves the τ meter is WIRED onto the chat HTTP path through the real gateway
 * server: a Clerk-authed request whose server-derived `user_scope` exhausts its
 * window budget gets HTTP 429 + Retry-After (the existing rate-limit envelope),
 * a non-Clerk (token-only, unscoped) request is NEVER throttled even when τ is
 * enabled, and two distinct user_scopes are independent budgets.
 *
 * Identity mechanism (no new auth bypass): we drive a REAL Clerk-JWT auth the
 * same way the production chat path does — a `Bearer <RS256-JWS>` verified
 * server-side against a JWKS. To make verification deterministic in-process we
 * mint a test keypair, serve its public JWK from a local HTTP JWKS endpoint, and
 * point `gateway.auth.clerk.jwksUrl` at it. The verified `sub` becomes the
 * `user_scope` the meter keys on (mirrors auth-clerk.test.ts minting + the
 * #834/#836 externalId threading).
 */

import { generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

// --- Clerk JWT minting (mirrors auth-clerk.test.ts) ------------------------

const KID = "tau-e2e-kid";
const ISSUER = "https://tau-e2e.clerk.test";
const AUDIENCE = "openclaw-tau-e2e";

type JwkWithMeta = JsonWebKey & { kid?: string; alg?: string; use?: string };

function makeKeypair(kid: string): { privateKey: KeyObject; jwk: JwkWithMeta } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JwkWithMeta;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function mintToken(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = b64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64url(payload);
  const signingInput = `${header}.${body}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

function clerkBearer(sub: string, privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  return mintToken({ sub, iss: ISSUER, aud: AUDIENCE, exp: now + 3600, nbf: now - 60 }, privateKey);
}

// --- Local JWKS endpoint so the real verifier resolves keys in-process ------

let jwksServer: Server | undefined;
let jwksUrl = "";
let privateKey: KeyObject;

beforeAll(async () => {
  const kp = makeKeypair(KID);
  privateKey = kp.privateKey;
  jwksServer = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [kp.jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer!.listen(0, "127.0.0.1", resolve));
  const addr = jwksServer.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!jwksServer) {
      resolve();
      return;
    }
    jwksServer.close(() => resolve());
  });
});

// --- Server spinup with Clerk + τ enabled -----------------------------------

type TauOverrides = {
  maxCostPerWindow?: number;
  windowMs?: number;
  retryAfterMs?: number;
};

async function startTauServer(port: number, tau: TauOverrides) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    controlUiEnabled: false,
    openResponsesEnabled: true,
    openAiChatCompletionsEnabled: true,
    auth: {
      mode: "token",
      token: "secret",
      clerk: { jwksUrl, issuer: ISSUER, audience: AUDIENCE },
      tau: { enabled: true, ...tau },
    },
  });
}

async function postResponses(port: number, bearer: string, body: unknown) {
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

async function postChatCompletions(port: number, bearer: string, body: unknown) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

async function drain(res: Response) {
  if (res.bodyUsed) {
    return;
  }
  try {
    await res.text();
  } catch {
    /* best-effort */
  }
}

const RESPONSE_BODY = { model: "openclaw", input: "hi" };

function mockAgentOnce() {
  agentCommand.mockReset();
  agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);
}

// Mock a single agent turn whose reported usage carries through
// extractUsageFromResult() -> tauTurnCost(). The result shape mirrors the live
// runtime: usage lives at meta.agentMeta.usage, and toUsage() derives
// total_tokens from `total` (or input+output+cache* when total is absent).
function mockAgentOnceWithTotalTokens(totalTokens: number) {
  agentCommand.mockReset();
  agentCommand.mockResolvedValueOnce({
    payloads: [{ text: "ok" }],
    meta: { agentMeta: { usage: { total: totalTokens } } },
  } as never);
}

describe("integration/tau-meter — τ meter wired onto the chat HTTP path (§9)", () => {
  it("exhausting a Clerk user_scope budget returns 429 + Retry-After on the next request", async () => {
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: 1,
      windowMs: 60_000,
      retryAfterMs: 60_000,
    });
    try {
      const bearer = clerkBearer("user_tau_exhaust", privateKey);

      // First Clerk-authed turn: succeeds (budget = 1).
      mockAgentOnce();
      const first = await postResponses(port, bearer, RESPONSE_BODY);
      expect(first.status).toBe(200);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      await drain(first);

      // Second turn for the SAME user_scope within the window: throttled.
      agentCommand.mockReset();
      const second = await postResponses(port, bearer, RESPONSE_BODY);
      expect(second.status).toBe(429);

      const retryAfter = second.headers.get("retry-after");
      expect(retryAfter).toBeTruthy();
      expect(Number(retryAfter)).toBeGreaterThan(0);

      const body = (await second.json()) as { error?: { type?: string } };
      expect(body.error?.type).toBe("rate_limited");

      // The throttled request must NOT have reached the agent.
      expect(agentCommand).not.toHaveBeenCalled();
    } finally {
      await server.close({ reason: "tau exhaust test done" });
    }
  });

  it("a non-Clerk (token-only, unscoped) request is NEVER throttled even with τ enabled", async () => {
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: 1,
      windowMs: 60_000,
      retryAfterMs: 60_000,
    });
    try {
      // Legacy shared-token auth carries no Clerk `sub` => no user_scope => the
      // meter must fail-open and never 429 this path. Fire several times well
      // past the tiny budget; every one stays on the happy path.
      for (let i = 0; i < 4; i++) {
        mockAgentOnce();
        const res = await postResponses(port, "secret", RESPONSE_BODY);
        expect(res.status).toBe(200);
        await drain(res);
      }
    } finally {
      await server.close({ reason: "tau unscoped test done" });
    }
  });

  it("distinct user_scopes are independent budgets (one exhausted, the other admitted)", async () => {
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: 1,
      windowMs: 60_000,
      retryAfterMs: 60_000,
    });
    try {
      const aliceBearer = clerkBearer("user_alice", privateKey);
      const bobBearer = clerkBearer("user_bob", privateKey);

      // Exhaust Alice.
      mockAgentOnce();
      const aliceFirst = await postResponses(port, aliceBearer, RESPONSE_BODY);
      expect(aliceFirst.status).toBe(200);
      await drain(aliceFirst);

      agentCommand.mockReset();
      const aliceSecond = await postResponses(port, aliceBearer, RESPONSE_BODY);
      expect(aliceSecond.status).toBe(429);
      await drain(aliceSecond);

      // Bob is a different user_scope and must still be admitted.
      mockAgentOnce();
      const bobFirst = await postResponses(port, bobBearer, RESPONSE_BODY);
      expect(bobFirst.status).toBe(200);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      await drain(bobFirst);
    } finally {
      await server.close({ reason: "tau independence test done" });
    }
  });

  it("under budget the happy path is unchanged (no-op below threshold, §9c)", async () => {
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: 5,
      windowMs: 60_000,
    });
    try {
      const bearer = clerkBearer("user_under_budget", privateKey);
      // Three turns, all under the budget of 5 -> all succeed, none throttled.
      for (let i = 0; i < 3; i++) {
        mockAgentOnce();
        const res = await postResponses(port, bearer, RESPONSE_BODY);
        expect(res.status).toBe(200);
        await drain(res);
      }
    } finally {
      await server.close({ reason: "tau under-budget test done" });
    }
  });

  // --- REGRESSION 1 (CRITICAL): /v1/chat/completions must DEBIT the meter -----
  // Defect: openai-http.ts called tauMeter.check() but never record(), so the
  // OpenAI-compat chat surface enforced a budget it never debited. Earlier e2e
  // coverage only drove /v1/responses, leaving this surface unmetered. These
  // tests are the regression LOCK: removing the record() calls from
  // openai-http.ts MUST make the first test below fail.

  it("REGRESSION 1: /v1/chat/completions debits the τ budget — second turn for the same Clerk scope is 429'd and the agent is NOT re-invoked", async () => {
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: 1,
      windowMs: 60_000,
      retryAfterMs: 60_000,
    });
    try {
      const bearer = clerkBearer("user_chatcmpl_exhaust", privateKey);
      const body = {
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      };

      // First Clerk-authed turn: succeeds (budget = 1) and reaches the agent.
      mockAgentOnce();
      const first = await postChatCompletions(port, bearer, body);
      expect(first.status).toBe(200);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      await drain(first);

      // Second turn for the SAME user_scope in the window: throttled. This only
      // holds if the first turn's record() debited the budget — the lock.
      agentCommand.mockReset();
      const second = await postChatCompletions(port, bearer, body);
      expect(second.status).toBe(429);

      const retryAfter = second.headers.get("retry-after");
      expect(retryAfter).toBeTruthy();
      expect(Number(retryAfter)).toBeGreaterThan(0);

      // The throttled request must NOT have reached the agent.
      expect(agentCommand).not.toHaveBeenCalled();
      await drain(second);
    } finally {
      await server.close({ reason: "tau chatcmpl exhaust test done" });
    }
  });

  it("REGRESSION 1: an UNSCOPED (token-only, no-Clerk) /v1/chat/completions request is never 429'd even with τ enabled", async () => {
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: 1,
      windowMs: 60_000,
      retryAfterMs: 60_000,
    });
    try {
      const body = {
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      };
      // Shared-token auth carries no Clerk `sub` => no user_scope => the meter
      // must fail-open. Fire several times past the tiny budget; all stay 200.
      for (let i = 0; i < 4; i++) {
        mockAgentOnce();
        const res = await postChatCompletions(port, "secret", body);
        expect(res.status).toBe(200);
        await drain(res);
      }
    } finally {
      await server.close({ reason: "tau chatcmpl unscoped test done" });
    }
  });

  // --- REGRESSION 2 (HIGH): tauTurnCost token-cost mapping, end-to-end --------
  // tauTurnCost() debits a turn by its reported total_tokens (when positive),
  // falling back to 1 only when usage is absent. tauTurnCost is private and
  // unexported; rather than export it we prove the mapping THROUGH the meter on
  // the /v1/responses path by feeding the mocked agent a known total_tokens and
  // asserting the budget is consumed by the token count, not by 1.

  it("REGRESSION 2: a single turn reporting total_tokens = N consumes the whole maxCostPerWindow = N (debit is by token count, not 1)", async () => {
    const N = 5;
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: N,
      windowMs: 60_000,
      retryAfterMs: 60_000,
    });
    try {
      const bearer = clerkBearer("user_token_cost_exact", privateKey);

      // One turn reports total_tokens = N. If the debit were a flat 1 this turn
      // would leave N-1 budget and the next turn would pass; the token-cost
      // mapping makes it consume the entire window in one turn.
      mockAgentOnceWithTotalTokens(N);
      const first = await postResponses(port, bearer, RESPONSE_BODY);
      expect(first.status).toBe(200);
      await drain(first);

      // Next turn for the same scope: budget already exhausted by the N-token
      // turn -> 429.
      agentCommand.mockReset();
      const second = await postResponses(port, bearer, RESPONSE_BODY);
      expect(second.status).toBe(429);
      expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(agentCommand).not.toHaveBeenCalled();
      await drain(second);
    } finally {
      await server.close({ reason: "tau token-cost exact test done" });
    }
  });

  it("REGRESSION 2: control — with NO usage (fallback cost 1) and maxCostPerWindow = 2, two turns are admitted before the 3rd 429s", async () => {
    const port = await getFreePort();
    const server = await startTauServer(port, {
      maxCostPerWindow: 2,
      windowMs: 60_000,
      retryAfterMs: 60_000,
    });
    try {
      const bearer = clerkBearer("user_token_cost_fallback", privateKey);

      // No usage reported -> tauTurnCost falls back to 1 per turn. Budget 2 =>
      // exactly two turns admitted.
      mockAgentOnce();
      const first = await postResponses(port, bearer, RESPONSE_BODY);
      expect(first.status).toBe(200);
      await drain(first);

      mockAgentOnce();
      const second = await postResponses(port, bearer, RESPONSE_BODY);
      expect(second.status).toBe(200);
      await drain(second);

      // Third turn: budget (2) exhausted by the two cost-1 turns -> 429.
      agentCommand.mockReset();
      const third = await postResponses(port, bearer, RESPONSE_BODY);
      expect(third.status).toBe(429);
      expect(agentCommand).not.toHaveBeenCalled();
      await drain(third);
    } finally {
      await server.close({ reason: "tau token-cost fallback test done" });
    }
  });
});
