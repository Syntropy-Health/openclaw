import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveUser } from "./index.js";
import { TokenCipher } from "./token-cipher.js";

const TOKEN = "sj_resolve_supersecret_token_77";

function sqlReturning(rows: unknown[]) {
  return vi.fn(() => Promise.resolve(rows)) as never;
}

describe("resolveUser with the app cipher", () => {
  const cipher = new TokenCipher(randomBytes(32), "kid-r");

  it("GREEN: an encrypted row resolves to its token", async () => {
    const row = { id: "u1", external_id: "user_ext", token_ciphertext: cipher.seal("u1", TOKEN) };
    const user = await resolveUser(sqlReturning([row]), null, "sms", "peer", cipher);
    expect(user?.authToken).toBe(TOKEN);
  });

  it("RED: a tampered row fails CLOSED and LOUD (unpaired + named code), never silent", async () => {
    const parts = cipher.seal("u1", TOKEN).split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 0xff;
    parts[4] = ct.toString("base64url");
    const row = {
      id: "u1",
      external_id: "user_ext",
      token_ciphertext: parts.join("."),
      auth_token: "legacy",
    };
    const onTokenError = vi.fn();
    const user = await resolveUser(sqlReturning([row]), null, "sms", "peer", cipher, onTokenError);
    expect(user).toBeNull();
    expect(onTokenError).toHaveBeenCalledWith("tamper");
    expect(JSON.stringify(onTokenError.mock.calls)).not.toContain(TOKEN);
  });

  it("RED: a wrong or rotated key fails closed with a named code", async () => {
    const other = new TokenCipher(randomBytes(32), "kid-other");
    const row = { id: "u1", external_id: "user_ext", token_ciphertext: other.seal("u1", TOKEN) };
    const onTokenError = vi.fn();
    expect(
      await resolveUser(sqlReturning([row]), null, "sms", "peer", cipher, onTokenError),
    ).toBeNull();
    expect(onTokenError).toHaveBeenCalledWith("key_mismatch");
  });
});

// Log arm: no logger call in the token-store code paths interpolates the token, the
// plaintext, the DEK or the wrapped DEK. `safeErr(err, [..., verified.authToken])` is
// the one allowed mention: it passes the token as a value to REDACT, not to print.
describe("log guard: the token and key never reach a log line", () => {
  const files = [
    "extensions/syntropy/src/token-cipher.ts",
    "extensions/syntropy/src/db.ts",
    "extensions/syntropy/src/index.ts",
    "extensions/persist-user-identity/src/commands.ts",
    "extensions/persist-user-identity/src/index.ts",
  ];
  const root = path.resolve(import.meta.dirname, "../../..");
  const SECRET = /\b(authToken|plaintext|dek|wrappedDek|wrappedDekB64|envelope|token_ciphertext)\b/;

  it("token-cipher.ts has no logger or console at all", () => {
    const src = fs.readFileSync(path.join(root, files[0]), "utf8");
    expect(src).not.toMatch(/\b(logger|console)\./);
  });

  for (const rel of files.slice(1)) {
    it(`${rel}: no logger.* call carries a secret identifier`, () => {
      const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!/logger\.(info|warn|error|debug)\(/.test(lines[i])) continue;
        // a log call can span a few lines: inspect it up to the closing `);`
        let stmt = "";
        for (let j = i; j < Math.min(lines.length, i + 6); j++) {
          stmt += lines[j];
          if (lines[j].includes(");")) break;
        }
        // Only CODE can leak a value: keep `${...}` interpolations of template
        // literals, drop literal text (so "legacy-plaintext" in a message is fine),
        // and drop safeErr(...) redaction calls.
        const code = stmt
          .replace(/`(?:[^`\\]|\\.)*`/g, (tpl) => (tpl.match(/\$\{[^}]*\}/g) ?? []).join(" "))
          .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
          .replace(/safeErr\([^)]*\)/g, "");
        if (SECRET.test(code)) offenders.push(`${rel}:${i + 1}`);
      }
      expect(offenders).toEqual([]);
    });
  }
});
