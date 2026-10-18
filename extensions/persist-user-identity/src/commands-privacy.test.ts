/**
 * mono #543 RED arms (CTO #15030): command replies never echo other linked
 * channels' peers, and !identify (no auth) never echoes names.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SMS = "+15551234567";
const MOBILE_DEVICE = "6f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const WA = "15559876543";

vi.mock("../../syntropy/src/vault.js", () => ({
  secretNameForUser: (id: string) => `syntropy_user_${id}`,
  createSyntropyVault: vi.fn(),
  vaultRpcsInstalled: vi.fn(async () => true),
}));
vi.mock("../../syntropy/src/db.js", () => ({ upsertSyntropyToken: vi.fn(async () => {}) }));
vi.mock("./jwt.js", () => ({
  verifyToken: vi.fn(async () => ({ externalId: "user_x", firstName: "Jane", lastName: "Doe" })),
  verifyViaPasscode: vi.fn(async () => ({
    externalId: "user_x",
    firstName: "Jane",
    lastName: "Doe",
  })),
  lookupUserByName: vi.fn(async () => [
    { userId: "a", email: "a@x", firstName: "Jane", lastName: "Doe" },
    { userId: "b", email: "b@x", firstName: "Janet", lastName: "Doer" },
    { userId: "c", email: "c@x", firstName: "Jan", lastName: "Dough" },
  ]),
}));
vi.mock("./db.js", () => ({
  createUser: vi.fn(async () => ({ id: "u1", first_name: "Jane", last_name: "Doe" })),
  findUserByChannelPeer: vi.fn(async (_sql: unknown, channel: string, peer: string) =>
    channel === "whatsapp" && peer === WA
      ? {
          id: "u1",
          first_name: "Jane",
          last_name: "Doe",
          verified: true,
          external_id: "user_x",
          channel,
          channel_peer_id: WA,
        }
      : null,
  ),
  findUserByExternalId: vi.fn(async () => ({ id: "u1", first_name: "Jane", last_name: "Doe" })),
  linkChannelToUser: vi.fn(async () => {}),
  linkExternalId: vi.fn(async () => {}),
  updateUserName: vi.fn(async () => {}),
}));

type Handler = (ctx: Record<string, unknown>) => Promise<{ text: string }>;

async function handlers(pending: Map<string, unknown> = new Map()): Promise<Map<string, Handler>> {
  const { registerIdentityCommands } = await import("./commands.js");
  const map = new Map<string, Handler>();
  const api = {
    registerCommand: (c: { name: string; handler: Handler }) => map.set(c.name, c.handler),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as OpenClawPluginApi;
  registerIdentityCommands(api, {
    sql: {} as never,
    authConfig: {
      mode: "passcode-endpoint",
      passcodeVerifyUrl: "https://sj.example/verify",
      userLookupUrl: "https://sj.example/users/search",
    } as never,
    ensureReady: async () => {},
    getVault: () => null,
    pendingIdentify: pending as never,
  });
  return map;
}

function peersIn(text: string): string[] {
  return [SMS, "5551234567", MOBILE_DEVICE, WA].filter((p) => text.includes(p));
}

describe("mono #543: replies never list other channels' peers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("!verify over WhatsApp prints 0 SMS/mobile peers and masks its own", async () => {
    const h = await handlers();
    // A NEW WhatsApp peer (not the already-linked one) completes verification.
    const out = await h.get("verify")!({
      args: "123456",
      channel: "whatsapp",
      senderId: "15550001111",
    });
    expect(out.text).toContain("Identity verified");
    expect(peersIn(out.text)).toEqual([]);
    expect(out.text).not.toContain("sms");
    expect(out.text).not.toContain("shrinemobile");
    expect(out.text).toContain("whatsapp (…1111)");
    expect(out.text).not.toContain("15550001111");
  });

  it("the channel-list command shows only the issuing channel, masked", async () => {
    const h = await handlers();
    const out = await h.get("whoami")!({ channel: "whatsapp", senderId: WA });
    expect(peersIn(out.text)).toEqual([]);
    expect(out.text).not.toContain("sms");
    expect(out.text).not.toContain("shrinemobile");
    expect(out.text).toContain("…6543");
  });
});

describe("mono #543: !identify never echoes names (CWE-203)", () => {
  it("3 matches: 0 names, no count, and the !verify continuation", async () => {
    const h = await handlers();
    const out = await h.get("identify")!({ args: "Jane Doe", channel: "sms", senderId: SMS });
    for (const n of ["Jane", "Janet", "Jan ", "Doe", "Doer", "Dough"])
      expect(out.text).not.toContain(n);
    expect(out.text).not.toMatch(/\b[23]\b|few|matches/i);
    expect(out.text).toContain("A match was found — continue with !verify");
  });
});

describe("mono #543 review: the identify → verify contract", () => {
  it("ONE match: pins its identifier, !verify uses it, and the pin is cleared on success", async () => {
    const jwt = await import("./jwt.js");
    vi.mocked(jwt.lookupUserByName).mockResolvedValueOnce([
      { userId: "a", email: "only@x", firstName: "Jane", lastName: "Doe" } as never,
    ]);
    const pending = new Map<string, { email: string }>();
    const h = await handlers(pending);
    const id = await h.get("identify")!({ args: "Jane Doe", channel: "sms", senderId: SMS });
    expect(id.text).not.toContain("Jane");
    expect(pending.get(`sms:${SMS}`)?.email).toBe("only@x");
    await h.get("verify")!({ args: "123456", channel: "sms", senderId: SMS });
    expect(vi.mocked(jwt.verifyViaPasscode).mock.calls.at(-1)?.[1]).toBe("only@x");
    expect(pending.has(`sms:${SMS}`)).toBe(false);
  });

  it("SEVERAL matches: pins nothing (a wrong identifier would fail the real user's verify)", async () => {
    const pending = new Map<string, unknown>();
    const h = await handlers(pending);
    await h.get("identify")!({ args: "Jane Doe", channel: "sms", senderId: SMS });
    expect(pending.size).toBe(0);
  });
});

describe("maskPeerForDisplay", () => {
  it("shows the last 4 only for ids of 10+ characters", async () => {
    const { maskPeerForDisplay } = await import("../../shared/log-redact.js");
    expect(maskPeerForDisplay("+15551234567")).toBe("…4567");
    expect(maskPeerForDisplay("abcde")).toBe("…");
    expect(maskPeerForDisplay("unknown")).toBe("…");
    expect(maskPeerForDisplay(undefined)).toBe("…");
  });
});
