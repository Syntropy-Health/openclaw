import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The chat endpoints run an end user (a Clerk sign-in) on the end-user agent,
// whatever agent the request names; operator callers keep agent routing.

const END_USER_TOKEN = "end-user-session-token";
vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return {
    ...actual,
    authorizeGatewayConnect: async (params: Parameters<typeof actual.authorizeGatewayConnect>[0]) =>
      params.connectAuth?.token === END_USER_TOKEN
        ? { ok: true, method: "clerk-jwt", externalId: "user_2abc" }
        : actual.authorizeGatewayConnect(params),
  };
});

const { agentCommand, getFreePort, installGatewayTestHooks, testState } =
  await import("./test-helpers.js");

installGatewayTestHooks({ scope: "suite" });

let server: { close: (opts?: { reason?: string }) => Promise<void> };
let port = 0;

beforeAll(async () => {
  port = await getFreePort();
  const { startGatewayServer } = await import("./server.js");
  server = await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: true,
    openResponsesEnabled: true,
  });
});

afterAll(async () => {
  await server.close({ reason: "chat end-user agent suite done" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  testState.agentsConfig = undefined;
});

const AGENTS = { list: [{ id: "main", default: true }, { id: "shrine" }, { id: "beta" }] };

const ENDPOINTS = [
  {
    name: "/v1/chat/completions",
    body: (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] }),
  },
  { name: "/v1/responses", body: (model: string) => ({ model, input: "hi" }) },
] as const;

async function sessionKeyFor(
  endpoint: (typeof ENDPOINTS)[number],
  bearer: string,
  model: string,
  headers: Record<string, string> = {},
): Promise<string> {
  agentCommand.mockReset();
  agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
  const res = await fetch(`http://127.0.0.1:${port}${endpoint.name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...headers },
    body: JSON.stringify(endpoint.body(model)),
  });
  expect(res.status).toBe(200);
  await res.text();
  expect(agentCommand).toHaveBeenCalledTimes(1);
  const [opts] = agentCommand.mock.calls[0] ?? [];
  return (opts as { sessionKey?: string } | undefined)?.sessionKey ?? "";
}

describe.each(ENDPOINTS)("$name agent selection", (endpoint) => {
  it("end user: an agent header is ignored", async () => {
    expect(
      await sessionKeyFor(endpoint, END_USER_TOKEN, "openclaw", { "x-openclaw-agent-id": "beta" }),
    ).toMatch(/^agent:main:/);
  });

  it("end user: an agent model is ignored", async () => {
    expect(await sessionKeyFor(endpoint, END_USER_TOKEN, "openclaw:beta")).toMatch(/^agent:main:/);
  });

  it("end user: OPENCLAW_CLERK_AGENT_ID names the agent", async () => {
    testState.agentsConfig = AGENTS;
    vi.stubEnv("OPENCLAW_CLERK_AGENT_ID", "shrine");
    expect(
      await sessionKeyFor(endpoint, END_USER_TOKEN, "openclaw:beta", {
        "x-openclaw-agent-id": "beta",
      }),
    ).toMatch(/^agent:shrine:/);
  });

  it("end user: an OPENCLAW_CLERK_AGENT_ID naming no configured agent runs on main", async () => {
    testState.agentsConfig = AGENTS;
    vi.stubEnv("OPENCLAW_CLERK_AGENT_ID", "ops");
    expect(
      await sessionKeyFor(endpoint, END_USER_TOKEN, "openclaw:beta", {
        "x-openclaw-agent-id": "beta",
      }),
    ).toMatch(/^agent:main:/);
  });

  it("operator: agent routing is unchanged", async () => {
    expect(
      await sessionKeyFor(endpoint, "secret", "openclaw", { "x-openclaw-agent-id": "beta" }),
    ).toMatch(/^agent:beta:/);
    expect(await sessionKeyFor(endpoint, "secret", "openclaw:beta")).toMatch(/^agent:beta:/);
  });
});
