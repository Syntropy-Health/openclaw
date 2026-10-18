import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LOG_REDACT_KEY_ENV, logToken, redactPeer, safeErr } from "./log-redact.js";

const PHONE = "+19785550123";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("logToken / redactPeer", () => {
  test("keyed: hmac token, stable for one key, never contains the input", () => {
    const a = redactPeer("sms", PHONE, "k1");
    expect(a).toMatch(/^sms:hmac:[0-9a-f]{12}$/);
    expect(a).toBe(redactPeer("sms", PHONE, "k1"));
    expect(a).not.toContain("9785550123");
    expect(redactPeer("sms", "+19785550124", "k1")).not.toBe(a);
  });

  test("the key matters: a different key gives a different token (not a plain hash)", () => {
    expect(logToken(PHONE, "k1")).not.toBe(logToken(PHONE, "k2"));
  });

  test("no key: literal 'redacted', never a hash or the raw value", () => {
    vi.stubEnv(LOG_REDACT_KEY_ENV, "");
    expect(redactPeer("sms", PHONE)).toBe("sms:redacted");
    expect(logToken(PHONE, "   ")).toBe("redacted");
  });

  test("reads the key from the environment at call time", () => {
    vi.stubEnv(LOG_REDACT_KEY_ENV, "envkey");
    expect(logToken(PHONE)).toBe(logToken(PHONE, "envkey"));
  });

  test("empty value -> '-'", () => {
    expect(logToken(undefined, "k1")).toBe("-");
    expect(logToken("  ", "k1")).toBe("-");
  });
});

describe("safeErr (mono #540)", () => {
  test("drops the given sensitive value and any E.164 shape, keeps the rest of the message", () => {
    const err = new Error(`invalid input for peer ${PHONE} near "x"; other +447700900123 seen`);
    const out = safeErr(err, [PHONE]);
    expect(out).not.toContain("9785550123");
    expect(out).not.toContain("447700900123");
    expect(out).toContain("Error: invalid input for peer");
    expect(out).toContain('near "x"');
    expect(out).toContain("[e164]");
  });

  test("a non-phone sensitive value (device id) is replaced by its token", () => {
    vi.stubEnv(LOG_REDACT_KEY_ENV, "k");
    const out = safeErr(new Error("unlink failed for device dev-abc-123"), ["dev-abc-123"]);
    expect(out).not.toContain("dev-abc-123");
    expect(out).toContain(logToken("dev-abc-123", "k"));
  });

  test("non-Error values and empty/short sensitive entries are handled", () => {
    expect(safeErr("plain failure", [undefined, null, "", "ab"])).toBe("plain failure");
    expect(safeErr({ toString: () => "obj +15551234567" })).toBe("obj [e164]");
  });

  test("scrubs unprefixed, formatted and WhatsApp-jid phone shapes, and the digits-only form of a caller value", () => {
    const msg =
      "a 15555550123 b 5555550123 c +1 (555) 555-0123 d +44 20 7946 0958 e 15555550123@s.whatsapp.net";
    const out = safeErr(new Error(msg));
    for (const raw of ["15555550123", "5555550123", "555-0123", "7946 0958"])
      expect(out).not.toContain(raw);
    expect(out).toContain("[e164]@s.whatsapp.net");
    const viaCaller = safeErr(new Error("peer 19785550123 missing"), [PHONE]);
    expect(viaCaller).not.toContain("9785550123");
  });

  test("does not mangle ordinary short numbers and ids", () => {
    expect(safeErr(new Error("attempt 3 of 5, code 23505, pool 20"))).toBe(
      "Error: attempt 3 of 5, code 23505, pool 20",
    );
  });

  test("keeps the error name (e.g. PostgresError)", () => {
    const e = new Error("connection terminated");
    e.name = "PostgresError";
    expect(safeErr(e)).toBe("PostgresError: connection terminated");
  });
});

describe("no raw error interpolation in identity/gate logger calls (mono #540 source guard)", () => {
  // Every logger call in these files must render errors via safeErr(); a raw
  // `${err}` / String(err) can ship an echoed peer to log storage.
  const FILES = [
    "../auth-memory-gate/src/index.ts",
    "../persist-user-identity/src/index.ts",
    "../persist-user-identity/src/commands.ts",
    "../persist-user-identity/src/signout-route.ts",
  ];
  function loggerCalls(src: string): string[] {
    const out: string[] = [];
    const re = /logger\??\.(?:debug|info|warn|error)\??\.?\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") depth -= 1;
        i += 1;
      }
      out.push(src.slice(m.index, i));
    }
    return out;
  }
  const RAW = /\$\{\s*[A-Za-z]*[Ee]rr\s*\}|String\(\s*[A-Za-z]*[Ee]rr\s*\)/;

  for (const rel of FILES) {
    test(`${rel}: every logger call that renders an error uses safeErr`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const calls = loggerCalls(src);
      expect(calls.length).toBeGreaterThan(0); // the guard sees the file's logger calls
      const offenders = calls.filter((c) => RAW.test(c));
      expect(offenders).toEqual([]);
    });
  }
});
