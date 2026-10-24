/**
 * Token cipher QG fix: a cipher failure (misconfig, KMS down or denied) fails ONLY the token
 * write in !verify. Identity binding still succeeds, and the user is told the token was not
 * saved. Before the fix the cipher loaded inside ensureReady and took identity down for everyone.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenCipherError } from "../../syntropy/src/token-cipher.js";

const TOKEN = "sj_cipherfail_secretpart_1234";

vi.mock("../../syntropy/src/vault.js", () => ({
  secretNameForUser: (id: string) => `syntropy_user_${id}`,
  createSyntropyVault: vi.fn(),
  vaultRpcsInstalled: vi.fn(async () => true),
}));
vi.mock("../../syntropy/src/db.js", () => ({ upsertSyntropyToken: vi.fn(async () => {}) }));
vi.mock("./jwt.js", () => ({
  verifyToken: vi.fn(),
  verifyViaPasscode: vi.fn(async () => ({
    externalId: "user_x",
    firstName: "Jane",
    lastName: "Doe",
    authToken: TOKEN,
  })),
  lookupUserByName: vi.fn(async () => []),
}));
vi.mock("./db.js", () => ({
  createUser: vi.fn(async () => ({ id: "u1", first_name: "Jane", last_name: "Doe" })),
  findUserByChannelPeer: vi.fn(async () => null),
  findUserByExternalId: vi.fn(async () => ({ id: "u1", first_name: "Jane", last_name: "Doe" })),
  linkChannelToUser: vi.fn(async () => {}),
  linkExternalId: vi.fn(async () => {}),
  updateUserName: vi.fn(async () => {}),
}));

type Handler = (ctx: Record<string, unknown>) => Promise<{ text: string }>;

async function verifyHandler(getCipher: () => Promise<never>, errors: string[]) {
  const { registerIdentityCommands } = await import("./commands.js");
  const map = new Map<string, Handler>();
  const api = {
    registerCommand: (c: { name: string; handler: Handler }) => map.set(c.name, c.handler),
    logger: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
  } as unknown as OpenClawPluginApi;
  registerIdentityCommands(api, {
    sql: {} as never,
    authConfig: {
      mode: "passcode-endpoint",
      passcodeVerifyUrl: "https://sj.example/verify",
    } as never,
    ensureReady: async () => {},
    getVault: () => null,
    getCipher,
    pendingIdentify: new Map() as never,
  });
  return map.get("verify")!;
}

describe("!verify with a failing token cipher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds the identity, stores no token, tells the user, and logs no secret", async () => {
    const db = await import("./db.js");
    const syntropyDb = await import("../../syntropy/src/db.js");
    const errors: string[] = [];
    const verify = await verifyHandler(async () => {
      throw new TokenCipherError("kek_unwrap_failed", "kms http 403");
    }, errors);

    const out = await verify({ args: "123456", channel: "whatsapp", senderId: "15550001111" });

    expect(out.text).toContain("Identity verified");
    expect(out.text).toContain("could not be saved");
    expect(vi.mocked(db.linkChannelToUser)).toHaveBeenCalled();
    expect(vi.mocked(syntropyDb.upsertSyntropyToken)).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("kek_unwrap_failed");
    expect(errors.join("\n")).not.toContain(TOKEN);
  });
});
