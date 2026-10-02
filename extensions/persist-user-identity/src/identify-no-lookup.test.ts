import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { registerIdentityCommands } from "./commands.js";

type Handler = (ctx: Record<string, unknown>) => Promise<{ text: string }>;

function identifyHandler(auth: Record<string, unknown>): {
  handler: Handler;
  fetchSpy: ReturnType<typeof vi.spyOn>;
} {
  const handlers = new Map<string, Handler>();
  const api = {
    registerCommand: (c: { name: string; handler: Handler }) => handlers.set(c.name, c.handler),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as OpenClawPluginApi;
  registerIdentityCommands(api, {
    sql: {} as never,
    authConfig: auth as never,
    ensureReady: async () => {},
    getVault: () => null,
    pendingIdentify: new Map(),
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  return { handler: handlers.get("identify")!, fetchSpy };
}

describe("!identify with no user-lookup endpoint configured", () => {
  it("says lookup is unavailable and points to !verify — never 'name not found'", async () => {
    const { handler, fetchSpy } = identifyHandler({
      mode: "passcode-endpoint",
      passcodeVerifyUrl: "https://sj.example/api/ext/pairing/verify",
    });
    const out = await handler({ args: "Jane Doe", channel: "sms", senderId: "+15550000001" });
    expect(out.text).toContain("!verify");
    expect(out.text).not.toMatch(/couldn't find that name/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("with a lookup endpoint that returns no match, the 'name not found' reply is unchanged", async () => {
    const { handler, fetchSpy } = identifyHandler({
      mode: "passcode-endpoint",
      passcodeVerifyUrl: "https://sj.example/api/ext/pairing/verify",
      userLookupUrl: "https://sj.example/api/ext/users/search",
    });
    fetchSpy.mockResolvedValue(new Response("[]", { status: 200 }));
    const out = await handler({ args: "Jane Doe", channel: "sms", senderId: "+15550000001" });
    expect(out.text).toMatch(/couldn't find that name/i);
    fetchSpy.mockRestore();
  });
});
