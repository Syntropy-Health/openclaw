/**
 * A two-user identity fixture (A = the verified caller, B = the victim) with a
 * fake tagged-template `sql` that answers the lp_users / lp_user_channels /
 * syntropy_tokens lookups the three identity hooks make. Shared by the
 * cross-user RED arms in syntropy, persist-user-identity and auth-memory-gate.
 *
 * The fake is STATELESS for reads (B's links stay B's whatever is written), and
 * it records every call so an arm can assert which identifiers were queried.
 */

export type FixtureUser = {
  id: string;
  external_id: string;
  first_name: string;
  last_name: string;
  created_at: Date;
  updated_at: Date;
};

const at = new Date(0);

export const USERS: Record<"A" | "B" | "C", FixtureUser> = {
  // A: the verified caller (has a stored SJ token).
  A: {
    id: "uid-A",
    external_id: "user_2A",
    first_name: "Alice",
    last_name: "Caller",
    created_at: at,
    updated_at: at,
  },
  // B: the victim (has a token and device/channel links).
  B: {
    id: "uid-B",
    external_id: "user_2B",
    first_name: "Bob",
    last_name: "Victim",
    created_at: at,
    updated_at: at,
  },
  // C: verified row, NO stored token (unpaired).
  C: {
    id: "uid-C",
    external_id: "user_2C",
    first_name: "Cara",
    last_name: "Unpaired",
    created_at: at,
    updated_at: at,
  },
};

export const TOKENS: Partial<Record<string, string>> = {
  "uid-A": "sj_tok_A",
  "uid-B": "sj_tok_B",
};

/** (channel, channel_peer_id) → user id. Every link belongs to the victim B. */
export const LINKS: Array<{ channel: string; peer: string; userId: string }> = [
  { channel: "shrinemobile", peer: "dev-B", userId: "uid-B" },
  { channel: "webchat", peer: "user_2B", userId: "uid-B" },
  { channel: "whatsapp", peer: "+15550001111", userId: "uid-B" },
];

export type SqlCall = { text: string; values: unknown[] };

function rowFor(user: FixtureUser, link?: { channel: string; peer: string }) {
  return {
    ...user,
    verified: true,
    auth_token: TOKENS[user.id] ?? null,
    vault_secret_name: null,
    token_ciphertext: null,
    ...(link ? { channel: link.channel, channel_peer_id: link.peer } : {}),
  };
}

/** Build the fake `sql`; `calls` collects every query (text normalised). */
export function makeFixtureSql(): {
  sql: ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
    end: () => Promise<void>;
  };
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const byId = (id: string) => Object.values(USERS).find((u) => u.id === id);
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (/^SELECT 1\b/.test(text)) {
      return Promise.resolve([{ "?column?": 1 }]);
    }
    if (text.startsWith("INSERT INTO lp_user_channels")) {
      // Reads stay stateless; the upsert reports ownership: a guarded upsert
      // (`WHERE lp_user_channels.user_id = EXCLUDED.user_id`) onto a link owned
      // by someone else returns no row.
      const [userId, channel, peer] = values as [string, string, string];
      const owner = LINKS.find((l) => l.channel === channel && l.peer === peer)?.userId;
      const guarded = text.includes("WHERE lp_user_channels.user_id = EXCLUDED.user_id");
      if (owner && owner !== userId && guarded) {
        return Promise.resolve([]);
      }
      return Promise.resolve([{ id: "link", user_id: userId, channel, channel_peer_id: peer }]);
    }
    if (!/^SELECT/.test(text)) {
      return Promise.resolve([]); // DDL / other inserts
    }
    if (text.includes("uc.channel = $") && text.includes("uc.channel_peer_id = $")) {
      const [channel, peer] = values as [string, string];
      const link = LINKS.find((l) => l.channel === channel && l.peer === peer);
      const user = link ? byId(link.userId) : undefined;
      return Promise.resolve(user && link ? [rowFor(user, link)] : []);
    }
    if (/external_id = \$/.test(text)) {
      const ext = values[0];
      const user = Object.values(USERS).find((u) => u.external_id === ext);
      return Promise.resolve(user ? [rowFor(user)] : []);
    }
    return Promise.resolve([]);
  }) as ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
    end: () => Promise<void>;
  };
  sql.end = () => Promise.resolve();
  return { sql, calls };
}

/** True when any SELECT was issued with `value` as a bound parameter. */
export function queriedWith(calls: SqlCall[], value: string): boolean {
  return calls.some((c) => c.text.startsWith("SELECT") && c.values.includes(value));
}
