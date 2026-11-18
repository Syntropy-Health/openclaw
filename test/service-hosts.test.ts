import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Tracked files name only approved service hosts: any host with a "syntropy"
// label must sit under an approved domain or a reserved test TLD.
const APPROVED_SERVICE_DOMAINS = ["syntropyhealth.bio", "shrinelongevity.com"];
// RFC 2606 / 6761 reserved names, used by tests and examples.
const RESERVED_TLDS = new Set(["example", "test", "invalid", "localhost"]);
// A bare dotted word is treated as a host only when it ends in one of these
// TLDs; this keeps code identifiers such as `entries.syntropy.config` out of
// the check. Hosts in an explicit URL, email or `host:` field are checked
// whatever their TLD (see HOST_FIELD_RE).
const HOST_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "ai",
  "co",
  "app",
  "dev",
  "bio",
  "health",
  "care",
  "cloud",
  "info",
  "xyz",
  "me",
  "us",
  "biz",
  "site",
  "online",
  "tech",
  "life",
  ...RESERVED_TLDS,
]);

const NAME = String.raw`(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]`;
const HOST_RE = new RegExp(NAME, "gi");
// Explicit host positions: after a URL scheme or an @, or as a `host:` value.
const HOST_FIELD_RE = new RegExp(
  String.raw`(?:[a-z][a-z0-9+.-]*://(?:[^/\s@"'<>]*@)?|@|\bhost:\s*["']?)(${NAME})`,
  "gi",
);

function namesService(host: string): boolean {
  return host.split(".").some((l) => l.includes("syntropy"));
}

function tldOf(host: string): string {
  const labels = host.split(".");
  return labels[labels.length - 1];
}

/** Hosts on the line that name the service but are not under an approved domain. */
function unapprovedServiceHosts(line: string, approved = APPROVED_SERVICE_DOMAINS): string[] {
  const candidates = new Set<string>();
  for (const match of line.matchAll(HOST_FIELD_RE)) {
    candidates.add(match[1].toLowerCase());
  }
  for (const match of line.matchAll(HOST_RE)) {
    const host = match[0].toLowerCase();
    if (HOST_TLDS.has(tldOf(host))) {
      candidates.add(host);
    }
  }
  const out: string[] = [];
  for (const host of candidates) {
    if (!namesService(host) || RESERVED_TLDS.has(tldOf(host))) {
      continue;
    }
    if (!approved.some((d) => host === d || host.endsWith(`.${d}`))) {
      out.push(host);
    }
  }
  return out;
}

const REPO = path.resolve(__dirname, "..");

/** Read failures other than "absent from this checkout" (sparse or deleted). */
const unreadable: string[] = [];

function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  return out.split("\0").filter((f) => {
    if (!f) {
      return false;
    }
    const abs = path.join(REPO, f);
    let buf: Buffer;
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile()) {
        return false;
      }
      buf = fs.readFileSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        unreadable.push(`${f}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
      }
      return false;
    }
    // Skip binaries (a NUL byte in the first 8 KiB).
    return !buf.subarray(0, 8192).includes(0);
  });
}

describe("approved service host matcher", () => {
  it("accepts approved service hosts and reserved test names", () => {
    expect(unapprovedServiceHosts("https://syntropy-api-test.shrinelongevity.com/mcp")).toEqual([]);
    expect(unapprovedServiceHosts("see https://docs.syntropyhealth.bio")).toEqual([]);
    expect(unapprovedServiceHosts('baseUrl: "https://api.syntropy.example"')).toEqual([]);
  });

  it("ignores code identifiers that only look dotted", () => {
    expect(unapprovedServiceHosts("cfg.plugins.entries.syntropy.config.syntropyBaseUrl")).toEqual(
      [],
    );
  });

  it("flags a service host outside the approved list, in any case (positive control)", () => {
    // Narrow the approved list so one of our own hosts must be flagged.
    const narrowed = ["syntropyhealth.bio"];
    expect(
      unapprovedServiceHosts("https://syntropy-api-test.shrinelongevity.com/mcp", narrowed),
    ).toEqual(["syntropy-api-test.shrinelongevity.com"]);
    expect(
      unapprovedServiceHosts("HTTPS://SYNTROPY-API-TEST.SHRINELONGEVITY.COM", narrowed),
    ).toEqual(["syntropy-api-test.shrinelongevity.com"]);
  });
});

describe("approved service host matcher: explicit host positions", () => {
  // `.zz` is a user-assigned ISO code, never delegated, so this names no real host.
  const host = "api.syntropy-check.zz";

  it("checks a host in a URL, email or host: field whatever its TLD", () => {
    expect(unapprovedServiceHosts(`see https://${host}/mcp`)).toEqual([host]);
    expect(unapprovedServiceHosts(`ops@${host}`)).toEqual([host]);
    expect(unapprovedServiceHosts(`      - host: ${host}`)).toEqual([host]);
    expect(unapprovedServiceHosts(`url: "wss://user@${host}:443/x"`)).toEqual([host]);
  });

  it("leaves a bare dotted word with an unlisted TLD alone (code identifiers)", () => {
    expect(unapprovedServiceHosts(`value ${host} here`)).toEqual([]);
  });
});

describe("tracked files", () => {
  const files = trackedTextFiles();

  it("every tracked file present in the checkout could be read", () => {
    expect(unreadable).toEqual([]);
  });

  it("scan covers the repository, docs and config included (positive control)", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const f of [
      "package.json",
      "docs/deployment/headless-syntropy.md",
      "nemoclaw/README.md",
      "nemoclaw/config/openclaw.json",
      "nemoclaw/policies/syntropy-sandbox.yaml",
    ]) {
      expect(files).toContain(f);
    }
  });

  it("name only approved service hosts", () => {
    const hits: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(REPO, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const host of unapprovedServiceHosts(line)) {
          hits.push(`${f}:${i + 1} ${host}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
