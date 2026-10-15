/**
 * For SMS/WhatsApp the channel peer id is the subscriber's E.164 phone number.
 * No logger call in this plugin may interpolate it (or the account ids) raw —
 * they go through the keyed shared/log-redact helpers.
 *
 * Source-level guard (the !verify / !register handlers have no logger-capturing
 * harness): every `logger.<level>(...)` call is extracted with comments
 * stripped, and each must be free of the raw interpolations. The guard also
 * asserts it FOUND the two identity log lines, so a refactor that renames the
 * logger cannot turn it into a vacuous pass.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const SRC = readFileSync(new URL("./commands.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function loggerCalls(src: string): string[] {
  const out: string[] = [];
  const re = /logger\.(?:debug|info|warn|error)\(/g;
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

const RAW = ["${peerId}", "${peerKey}", "${channelList}", "${user.id}", "${verified.externalId}"];

describe("persist-user-identity logs never carry the raw phone / account ids", () => {
  const calls = loggerCalls(SRC);

  test("the guard sees the verified + registered identity log lines", () => {
    expect(calls.some((c) => c.includes("persist-user-identity: verified "))).toBe(true);
    expect(calls.some((c) => c.includes("persist-user-identity: registered "))).toBe(true);
  });

  test("no logger call interpolates a raw peer id or account id", () => {
    const offenders = calls.filter((c) => RAW.some((r) => c.includes(r)));
    expect(offenders).toEqual([]);
  });
});
