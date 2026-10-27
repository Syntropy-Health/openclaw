/**
 * [G1] auto-bind ownership guard against REAL Postgres (the unit arms use a fake
 * that models ON CONFLICT … DO UPDATE … WHERE; this proves the real SQL).
 *
 * Requires DATABASE_URL in .env or environment; skipped otherwise. Use a LOCAL
 * or disposable database only — the suite writes and deletes its own rows.
 *
 * Run: DATABASE_URL=<url> pnpm vitest run extensions/persist-user-identity/src/bind.integration.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { AutoBindRefusedError, autoBindVerifiedPeer, ensureUserSchema } from "./db.js";

// Dynamically import postgres — it lives in extension node_modules
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sql: any;

const DB_URL = process.env.DATABASE_URL;

// Skip entire suite if no DATABASE_URL
const describeIf = DB_URL ? describe : describe.skip;

describeIf("autoBindVerifiedPeer — ownership guard (real Postgres)", () => {
  const run = `${Date.now()}`;
  const CHANNEL = "shrinemobile";
  const EXT_A = `bindit-A-${run}`;
  const EXT_B = `bindit-B-${run}`;
  const DEV_B = `bindit-dev-B-${run}`;
  const DEV_A1 = `bindit-dev-A1-${run}`;
  const DEV_A2 = `bindit-dev-A2-${run}`;
  let userA: string;
  let userB: string;

  const ownerOf = async (peer: string): Promise<string | undefined> => {
    const rows = await sql`
      SELECT user_id FROM lp_user_channels WHERE channel = ${CHANNEL} AND channel_peer_id = ${peer}
    `;
    return rows[0]?.user_id as string | undefined;
  };

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(DB_URL!, {
      ssl: { rejectUnauthorized: false },
      max: 3,
      idle_timeout: 10,
      connect_timeout: 10,
    });
    await ensureUserSchema(sql);
    [{ id: userA }] = await sql`INSERT INTO lp_users (external_id) VALUES (${EXT_A}) RETURNING id`;
    [{ id: userB }] = await sql`INSERT INTO lp_users (external_id) VALUES (${EXT_B}) RETURNING id`;
    await sql`
      INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
      VALUES (${userB}, ${CHANNEL}, ${DEV_B}), (${userA}, ${CHANNEL}, ${DEV_A1})
    `;
  });

  afterAll(async () => {
    if (!sql) {
      return;
    }
    await sql`DELETE FROM lp_user_channels WHERE channel_peer_id LIKE ${`bindit-dev-%-${run}`}`;
    await sql`DELETE FROM lp_users WHERE external_id IN (${EXT_A}, ${EXT_B})`;
    await sql.end({ timeout: 5 });
  });

  test("A auto-binding with B's device is refused and the link stays B's", async () => {
    await expect(
      autoBindVerifiedPeer(sql, { externalId: EXT_A, channel: CHANNEL, channelPeerId: DEV_B }),
    ).rejects.toBeInstanceOf(AutoBindRefusedError);
    expect(await ownerOf(DEV_B)).toBe(userB);
  });

  test("a same-owner rebind returns a row and advances linked_at", async () => {
    const [before] = await sql`
      SELECT linked_at FROM lp_user_channels WHERE channel = ${CHANNEL} AND channel_peer_id = ${DEV_B}
    `;
    await new Promise((r) => setTimeout(r, 25));
    const user = await autoBindVerifiedPeer(sql, {
      externalId: EXT_B,
      channel: CHANNEL,
      channelPeerId: DEV_B,
    });
    expect(user.id).toBe(userB);
    const [after] = await sql`
      SELECT linked_at FROM lp_user_channels WHERE channel = ${CHANNEL} AND channel_peer_id = ${DEV_B}
    `;
    expect(new Date(after.linked_at).getTime()).toBeGreaterThan(
      new Date(before.linked_at).getTime(),
    );
  });

  test("reinstall: A's NEW device binds while A's old binding still exists", async () => {
    await autoBindVerifiedPeer(sql, { externalId: EXT_A, channel: CHANNEL, channelPeerId: DEV_A2 });
    expect(await ownerOf(DEV_A2)).toBe(userA);
    expect(await ownerOf(DEV_A1)).toBe(userA);
  });

  test("A's old device later presented by B is still refused", async () => {
    await expect(
      autoBindVerifiedPeer(sql, { externalId: EXT_B, channel: CHANNEL, channelPeerId: DEV_A1 }),
    ).rejects.toBeInstanceOf(AutoBindRefusedError);
    expect(await ownerOf(DEV_A1)).toBe(userA);
  });
});
