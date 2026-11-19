import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

// The control-plane connection is an operator surface: a connect that
// authenticates as anything other than an operator is refused before any
// device pairing, even from a loopback client.

const NON_OPERATOR = {
  "end-user-session-token": { ok: true, method: "clerk-jwt", externalId: "user_A" },
  "unknown-method-token": { ok: true, method: "future-end-user" },
  "no-method-token": { ok: true },
} as Record<string, Record<string, unknown>>;
vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return {
    ...actual,
    authorizeGatewayConnect: async (params: Parameters<typeof actual.authorizeGatewayConnect>[0]) =>
      (params.connectAuth?.token && NON_OPERATOR[params.connectAuth.token]) ??
      actual.authorizeGatewayConnect(params),
  };
});

const { buildDeviceAuthPayload } = await import("./device-auth.js");
const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
  await import("../infra/device-identity.js");
const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
const { connectReq, installGatewayTestHooks, startServerWithClient } =
  await import("./test-helpers.js");

installGatewayTestHooks({ scope: "suite" });

const client = {
  id: GATEWAY_CLIENT_NAMES.TEST,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.TEST,
};

describe("gateway WS connect: end-user auth", () => {
  test.each(Object.keys(NON_OPERATOR))(
    "%s with a fresh device is refused, with no pairing request",
    async (presented) => {
      const { server, ws, prevToken } = await startServerWithClient("secret");
      try {
        const identityDir = await mkdtemp(join(tmpdir(), "openclaw-ws-end-user-"));
        const identity = loadOrCreateDeviceIdentity(join(identityDir, "device.json"));
        const signedAtMs = Date.now();
        const payload = buildDeviceAuthPayload({
          deviceId: identity.deviceId,
          clientId: client.id,
          clientMode: client.mode,
          role: "operator",
          scopes: ["operator.read"],
          signedAtMs,
          token: presented,
        });
        const before = await listDevicePairing();
        const res = await connectReq(ws, {
          token: presented,
          scopes: ["operator.read"],
          client,
          device: {
            id: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            signature: signDevicePayload(identity.privateKeyPem, payload),
            signedAt: signedAtMs,
          },
        });
        expect(res.ok).toBe(false);
        expect(await getPairedDevice(identity.deviceId)).toBeFalsy();
        const after = await listDevicePairing();
        expect(after.pending.length).toBe(before.pending.length);
        expect(after.pending.some((p) => p.deviceId === identity.deviceId)).toBe(false);
      } finally {
        ws.close();
        await server.close();
        if (prevToken === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
        }
      }
    },
  );

  test("the operator token still connects", async () => {
    const { server, ws, prevToken } = await startServerWithClient("secret");
    try {
      const res = await connectReq(ws, { token: "secret", client });
      expect(res.ok).toBe(true);
    } finally {
      ws.close();
      await server.close();
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }
  });
});
