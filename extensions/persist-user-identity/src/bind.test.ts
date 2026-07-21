import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { deriveIdentityPeer } from "../../shared/session-key.js";
import { autoBindVerifiedPeer, unlinkChannelPeerForUser, type UserRow } from "./db.js";

// ---------------------------------------------------------------------------
// Fake tagged-template `sql` — dispatches on query text, records calls.
// ---------------------------------------------------------------------------

type Call = { text: string; values: unknown[] };

function fakeSql(route: (text: string, values: unknown[]) => unknown[]): {
  sql: postgres.Sql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(route(text, values));
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

const USER: UserRow = {
  id: "uuid-user-1",
  external_id: "user_2abc",
  first_name: null,
  last_name: null,
  created_at: new Date(0),
  updated_at: new Date(0),
};

describe("autoBindVerifiedPeer (G-lane [G1])", () => {
  it("★ existing user: finds by external_id and UPSERTS the device link (no user insert)", async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes("SELECT * FROM lp_users WHERE external_id")) {
        return [USER];
      }
      if (text.includes("INSERT INTO lp_user_channels")) {
        return [{ id: "link-1", user_id: USER.id, channel: "shrinemobile" }];
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const user = await autoBindVerifiedPeer(sql, {
      externalId: "user_2abc",
      channel: "shrinemobile",
      channelPeerId: "device-uuid-1",
    });
    expect(user.id).toBe(USER.id);
    // exactly: find + link (NO lp_users INSERT)
    expect(calls.some((c) => c.text.includes("INSERT INTO lp_users "))).toBe(false);
    const link = calls.find((c) => c.text.includes("INSERT INTO lp_user_channels"));
    expect(link?.values).toEqual([USER.id, "shrinemobile", "device-uuid-1"]);
    expect(link?.text).toContain("ON CONFLICT (channel, channel_peer_id)"); // idempotent upsert
  });

  it("★ new user: creates the lp_users row CARRYING external_id, then links", async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes("SELECT * FROM lp_users WHERE external_id")) {
        return []; // not found
      }
      if (text.includes("INSERT INTO lp_users")) {
        return [USER];
      }
      if (text.includes("INSERT INTO lp_user_channels")) {
        return [{ id: "link-1" }];
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const user = await autoBindVerifiedPeer(sql, {
      externalId: "user_2abc",
      channel: "shrinemobile",
      channelPeerId: "device-uuid-1",
    });
    expect(user.external_id).toBe("user_2abc");
    const create = calls.find((c) => c.text.includes("INSERT INTO lp_users"));
    expect(create?.values).toContain("user_2abc"); // external_id comes from the VERIFIED sub
  });

  it("propagates DB failures (caller logs; never silently binds)", async () => {
    const { sql } = fakeSql(() => {
      throw new Error("pg down");
    });
    await expect(
      autoBindVerifiedPeer(sql, {
        externalId: "user_2abc",
        channel: "shrinemobile",
        channelPeerId: "d1",
      }),
    ).rejects.toThrow(/pg down/);
  });
});

describe("unlinkChannelPeerForUser (G-lane [G2] must-fix #1 — link-row DELETE only)", () => {
  it("★ deletes ONLY the caller's own (channel, peer) LINK row — never touches lp_users.external_id", async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes("DELETE FROM lp_user_channels")) {
        return [{ id: "link-1" }];
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const n = await unlinkChannelPeerForUser(sql, {
      externalId: "user_2abc",
      channel: "shrinemobile",
      channelPeerId: "device-uuid-1",
    });
    expect(n).toBe(1);
    const del = calls[0];
    // Ownership + target enforced IN the SQL (blast radius = one link row).
    expect(del.text).toContain("DELETE FROM lp_user_channels");
    expect(del.text).toContain("u.external_id = $");
    expect(del.text).toContain("uc.channel = $");
    expect(del.text).toContain("uc.channel_peer_id = $");
    expect(del.values).toEqual(["user_2abc", "shrinemobile", "device-uuid-1"]);
    // NEVER an UPDATE/DELETE on lp_users itself.
    expect(del.text).not.toMatch(/UPDATE lp_users|DELETE FROM lp_users/);
  });

  it("absent / not-owned row → 0 (idempotent no-op, indistinguishable from unowned)", async () => {
    const { sql } = fakeSql(() => []);
    const n = await unlinkChannelPeerForUser(sql, {
      externalId: "user_2abc",
      channel: "shrinemobile",
      channelPeerId: "device-uuid-1",
    });
    expect(n).toBe(0);
  });
});

describe("deriveIdentityPeer (shared — bind/gate/unbind consistency)", () => {
  it("★ prefers the threaded device id over the session-key-derived peer", () => {
    expect(
      deriveIdentityPeer({
        sessionKey: "agent:main:openresponses-user:user_2abc:hint",
        deviceId: "device-uuid-1",
      }),
    ).toBe("device-uuid-1");
  });

  it("falls back to the session-key peer when no device id is threaded", () => {
    expect(deriveIdentityPeer({ sessionKey: "agent:abc:whatsapp:direct:+15551234567" })).toBe(
      "+15551234567",
    );
  });

  it("whitespace-only device id does not count", () => {
    expect(
      deriveIdentityPeer({ sessionKey: "agent:abc:whatsapp:direct:+15551234567", deviceId: "  " }),
    ).toBe("+15551234567");
  });

  it("undefined ctx degrades to the raw-session-key fallback behavior", () => {
    expect(deriveIdentityPeer(undefined)).toBe("");
  });
});

describe("autoBindVerifiedPeer — concurrent first-turn race (unique external_id)", () => {
  it("★ createUser unique-violation → re-find wins the race and the link is STILL written", async () => {
    let selectCount = 0;
    const { sql, calls } = fakeSql((text) => {
      if (text.includes("SELECT * FROM lp_users WHERE external_id")) {
        selectCount += 1;
        // 1st find: not there yet; 2nd find (post-conflict): the parallel turn's row.
        return selectCount === 1 ? [] : [USER];
      }
      if (text.includes("INSERT INTO lp_users")) {
        throw new Error(
          'duplicate key value violates unique constraint "lp_users_external_id_key"',
        );
      }
      if (text.includes("INSERT INTO lp_user_channels")) {
        return [{ id: "link-1" }];
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const user = await autoBindVerifiedPeer(sql, {
      externalId: "user_2abc",
      channel: "shrinemobile",
      channelPeerId: "device-uuid-1",
    });
    expect(user.id).toBe(USER.id);
    // The device link was written despite the create losing the race.
    expect(calls.some((c) => c.text.includes("INSERT INTO lp_user_channels"))).toBe(true);
  });

  it("a GENUINE create failure (row still absent on re-find) rethrows", async () => {
    const { sql } = fakeSql((text) => {
      if (text.includes("SELECT * FROM lp_users WHERE external_id")) {
        return [];
      }
      if (text.includes("INSERT INTO lp_users")) {
        throw new Error("pg down");
      }
      throw new Error(`unexpected query: ${text}`);
    });
    await expect(
      autoBindVerifiedPeer(sql, {
        externalId: "user_2abc",
        channel: "shrinemobile",
        channelPeerId: "d1",
      }),
    ).rejects.toThrow(/pg down/);
  });
});
