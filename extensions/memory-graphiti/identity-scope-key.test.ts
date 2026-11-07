import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { deriveIdentityPeer } from "../shared/session-key.js";
import { resolveIdentityScopeKey, resolveVerifiedExternalId } from "./identity.js";

// Tagged-template SQL stand-in: records bound (channel, peer) values and returns
// a row only for registered pairs.
function fakeSql(table: Record<string, { id: string; external_id: string | null }>) {
  const peers: string[] = [];
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [channel, peer] = values as [string, string];
    peers.push(peer);
    const row = table[`${channel}|${peer}`];
    return row ? [row] : [];
  }) as unknown as postgres.Sql;
  return { sql, peers };
}

const USER_A = { id: "uuid-a", external_id: "user_a" };
const USER_B = { id: "uuid-b", external_id: "user_b" };

describe("identity: resolveIdentityScopeKey follows the gate's identity rules", () => {
  it("keys a channel turn on the same peer as the gate", async () => {
    const ctx = { sessionKey: "agent:main:telegram:direct:tg-a", messageProvider: "telegram" };
    const { sql, peers } = fakeSql({ "telegram|tg-a": USER_A });
    await resolveIdentityScopeKey(sql, ctx);
    expect(peers).toEqual([deriveIdentityPeer(ctx)]);
  });

  it("treats an unverified HTTP-shaped session as unidentified", async () => {
    const ctx = {
      sessionKey: "agent:main:openresponses-user:dev-b",
      messageProvider: "shrinemobile",
    };
    const { sql, peers } = fakeSql({ "shrinemobile|dev-b": USER_B });
    expect(await resolveIdentityScopeKey(sql, ctx)).toBeNull();
    expect(peers).toEqual([]);
  });

  it("resolveVerifiedExternalId treats an unverified HTTP-shaped session as unidentified", async () => {
    const ctx = {
      sessionKey: "agent:main:openresponses-user:hint-9",
      messageProvider: "shrinemobile",
      deviceId: "dev-b",
    };
    const { sql, peers } = fakeSql({ "shrinemobile|dev-b": USER_B });
    expect(await resolveVerifiedExternalId(sql, ctx)).toBeNull();
    expect(peers).toEqual([]);
  });

  it("resolveVerifiedExternalId still resolves a verified HTTP turn whose row matches the sub", async () => {
    const ctx = {
      sessionKey: "agent:main:openresponses-user:hint-9",
      messageProvider: "shrinemobile",
      deviceId: "dev-a",
      externalId: "user_a",
    };
    const { sql } = fakeSql({ "shrinemobile|dev-a": USER_A });
    expect(await resolveVerifiedExternalId(sql, ctx)).toBe("user_a");
  });

  it("still resolves a channel turn by (channel, peer)", async () => {
    const ctx = { sessionKey: "agent:main:telegram:direct:tg-a", messageProvider: "telegram" };
    const { sql } = fakeSql({ "telegram|tg-a": USER_A });
    expect(await resolveIdentityScopeKey(sql, ctx)).not.toBeNull();
  });
});
