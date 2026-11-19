import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { MissingEnvVarError, resolveConfigEnvVars } from "../src/config/env-substitution.js";
import { createConfigIO } from "../src/config/io.js";

// The NemoClaw sandbox config and its egress files must take the service
// endpoint from SYNTROPY_API_BASE_URL. Unset or empty must refuse, naming the
// setting; set must be used verbatim. No file may carry a default host.

const REPO = path.resolve(__dirname, "..");
const NEMOCLAW = path.join(REPO, "nemoclaw");
const SETTING = "SYNTROPY_API_BASE_URL";
const RENDER = path.join(NEMOCLAW, "scripts", "render-endpoints.sh");
const RENDERED_FILES = [
  "config/openclaw.json",
  "policies/syntropy-sandbox.yaml",
  "presets/syntropy.yaml",
  "agents/syntropy-openclaw/manifest.yaml",
];

function sandboxConfig(): unknown {
  return JSON.parse(fs.readFileSync(path.join(NEMOCLAW, "config", "openclaw.json"), "utf8"));
}

type Entries = Record<string, { config?: Record<string, unknown> }>;
function entries(cfg: unknown): Entries {
  return (cfg as { plugins: { entries: Entries } }).plugins.entries;
}

describe("nemoclaw sandbox config: service endpoints are required", () => {
  it("refuses to resolve when the setting is unset, naming it", () => {
    let caught: unknown;
    try {
      resolveConfigEnvVars(sandboxConfig(), {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingEnvVarError);
    expect(String((caught as Error).message)).toContain(SETTING);
  });

  it("refuses to resolve when the setting is empty, naming it", () => {
    expect(() => resolveConfigEnvVars(sandboxConfig(), { [SETTING]: "" })).toThrow(SETTING);
  });

  it("uses the configured base URL verbatim for every endpoint", () => {
    const base = "https://endpoints.example.test";
    const resolved = entries(resolveConfigEnvVars(sandboxConfig(), { [SETTING]: base }));
    const auth = resolved["persist-user-identity"]?.config?.auth as Record<string, unknown>;
    expect(auth.passcodeVerifyUrl).toBe(`${base}/api/ext/pairing/verify`);
    expect(auth.userLookupUrl).toBe(`${base}/api/ext/users/search`);
    expect(resolved.syntropy?.config?.syntropyBaseUrl).toBe(base);
  });
});

// The gateway starts through readConfigFileSnapshot(); server startup throws
// "Invalid config" on an invalid snapshot, so an invalid snapshot naming the
// setting is the refusal to start.
describe("nemoclaw sandbox config: gateway startup gate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  async function snapshotWith(env: NodeJS.ProcessEnv) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snap-"));
    dirs.push(home);
    const configPath = path.join(home, "openclaw.json");
    fs.copyFileSync(path.join(NEMOCLAW, "config", "openclaw.json"), configPath);
    const io = createConfigIO({ configPath, env: { ...env, HOME: home }, homedir: () => home });
    return io.readConfigFileSnapshot();
  }

  it("unset setting → invalid snapshot whose issue names the setting", async () => {
    const snap = await snapshotWith({});
    expect(snap.valid).toBe(false);
    expect(snap.issues.map((i) => i.message).join("\n")).toContain(SETTING);
  });

  it("empty setting → invalid snapshot whose issue names the setting", async () => {
    const snap = await snapshotWith({ [SETTING]: "" });
    expect(snap.valid).toBe(false);
    expect(snap.issues.map((i) => i.message).join("\n")).toContain(SETTING);
  });

  // Validity is not asserted: on this base the sandbox config also has schema
  // issues unrelated to the endpoint. What matters here is that none of them is
  // about the setting and that the loaded config carries the value verbatim.
  it("set → no issue about the setting; loaded config carries the value verbatim", async () => {
    const base = "https://endpoints.example.test";
    const snap = await snapshotWith({ [SETTING]: base });
    expect(snap.issues.map((i) => i.message).join("\n")).not.toContain(SETTING);
    const resolved = entries(snap.config);
    expect(resolved.syntropy?.config?.syntropyBaseUrl).toBe(base);
    const auth = resolved["persist-user-identity"]?.config?.auth as Record<string, unknown>;
    expect(auth.passcodeVerifyUrl).toBe(`${base}/api/ext/pairing/verify`);
    expect(auth.userLookupUrl).toBe(`${base}/api/ext/users/search`);
  });
});

describe("nemoclaw render-endpoints.sh", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function render(src: string, env: Record<string, string | undefined>) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-render-"));
    dirs.push(out);
    const dest = path.join(out, path.basename(src));
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) {
        childEnv[k] = v;
      }
    }
    const res = spawnSync("bash", [RENDER, src, dest], { env: childEnv, encoding: "utf8" });
    return { status: res.status, stderr: res.stderr, dest };
  }

  for (const rel of RENDERED_FILES) {
    const src = path.join(NEMOCLAW, rel);

    it(`${rel}: unset setting is refused and named`, () => {
      const res = render(src, {});
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(SETTING);
      expect(fs.existsSync(res.dest)).toBe(false);
    });

    it(`${rel}: empty setting is refused and named`, () => {
      const res = render(src, { [SETTING]: "" });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(SETTING);
      expect(fs.existsSync(res.dest)).toBe(false);
    });

    for (const bad of [
      "http://endpoints.example.test",
      "https://endpoints.example.test:8443",
      "https://169.254.169.254",
      // Hex and octal labels resolve to IP addresses too (loopback, link-local).
      "https://0x7f.0x1",
      "https://169.254.0xa9fe",
      "https://0177.0.0.1",
      "https://0X7F.0x1",
      "https://endpoints.example.test.",
      "https://[::1]",
      "https://10.endpoints.example.test",
      "https://localhost",
      "https://..",
      "https://-.-",
      "https://user@endpoints.example.test",
      "https://user:secret@endpoints.example.test",
      "https://endpoints.example.test/?q=1",
      // A path prefix would render cleanly and then be blocked by the egress
      // rules, which allow the service's root paths only.
      "https://endpoints.example.test/v1",
      "https://endpoints.example.test/v1/",
    ]) {
      it(`${rel}: ${bad} is refused, named, and nothing is written`, () => {
        const res = render(src, { [SETTING]: bad });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(SETTING);
        expect(fs.existsSync(res.dest)).toBe(false);
      });
    }

    it(`${rel}: nothing is left unresolved, and the output is world-readable`, () => {
      const res = render(src, { [SETTING]: "https://endpoints.example.test/" });
      expect(res.status).toBe(0);
      const text = fs.readFileSync(res.dest, "utf8");
      expect(text).not.toContain("__SYNTROPY_API_HOST__");
      expect(text).not.toContain("${SYNTROPY_API_BASE_URL}");
      expect(text).not.toContain("//api/");
      // Windows does not implement group/other permission bits.
      if (process.platform !== "win32") {
        expect(fs.statSync(res.dest).mode & 0o777).toBe(0o644);
      }
    });
  }

  it("a destination that is a directory is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-render-dir-"));
    dirs.push(dir);
    const childEnv = { PATH: process.env.PATH ?? "", [SETTING]: "https://endpoints.example.test" };
    const res = spawnSync("bash", [RENDER, path.join(NEMOCLAW, "config", "openclaw.json"), dir], {
      env: childEnv,
      encoding: "utf8",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("directory");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an explicit :443 is accepted", () => {
    const res = render(path.join(NEMOCLAW, "config", "openclaw.json"), {
      [SETTING]: "https://endpoints.example.test:443",
    });
    expect(res.status).toBe(0);
  });

  function renderedJson(base: string): Entries {
    const res = render(path.join(NEMOCLAW, "config", "openclaw.json"), { [SETTING]: base });
    expect(res.status).toBe(0);
    return entries(JSON.parse(fs.readFileSync(res.dest, "utf8")));
  }

  it("openclaw.json: every endpoint is the base URL verbatim (trailing slash trimmed)", () => {
    const e = renderedJson("https://endpoints.example.test/");
    const auth = e["persist-user-identity"]?.config?.auth as Record<string, unknown>;
    expect(auth.passcodeVerifyUrl).toBe("https://endpoints.example.test/api/ext/pairing/verify");
    expect(auth.userLookupUrl).toBe("https://endpoints.example.test/api/ext/users/search");
    expect(e.syntropy?.config?.syntropyBaseUrl).toBe("https://endpoints.example.test");
  });

  // Rendering may change nothing but the placeholder: the parsed document must
  // equal the source with the placeholder replaced by the bare host, so no
  // host can be added, dropped or altered.
  function replacePlaceholder(node: unknown, host: string): unknown {
    if (typeof node === "string") {
      return node.split("__SYNTROPY_API_HOST__").join(host);
    }
    if (Array.isArray(node)) {
      return node.map((n) => replacePlaceholder(n, host));
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, replacePlaceholder(v, host)]),
      );
    }
    return node;
  }

  for (const rel of [
    "policies/syntropy-sandbox.yaml",
    "presets/syntropy.yaml",
    "agents/syntropy-openclaw/manifest.yaml",
  ]) {
    it(`${rel}: rendering replaces only the placeholder with the bare host`, () => {
      const src = path.join(NEMOCLAW, rel);
      const res = render(src, { [SETTING]: "https://h.example.test/" });
      expect(res.status).toBe(0);
      const rendered = parseYaml(fs.readFileSync(res.dest, "utf8"));
      expect(rendered).toEqual(
        replacePlaceholder(parseYaml(fs.readFileSync(src, "utf8")), "h.example.test"),
      );
    });
  }

  for (const rel of ["policies/syntropy-sandbox.yaml", "presets/syntropy.yaml"]) {
    it(`${rel}: the service policy names exactly one host, the configured one`, () => {
      const res = render(path.join(NEMOCLAW, rel), { [SETTING]: "https://h.example.test" });
      expect(res.status).toBe(0);
      const doc = parseYaml(fs.readFileSync(res.dest, "utf8")) as {
        network_policies: { syntropy_api: { endpoints: Array<{ host: string }> } };
      };
      expect(doc.network_policies.syntropy_api.endpoints.map((e) => e.host)).toEqual([
        "h.example.test",
      ]);
    });
  }

  it("the source files carry no host of their own, only the placeholder", () => {
    for (const rel of RENDERED_FILES) {
      const text = fs.readFileSync(path.join(NEMOCLAW, rel), "utf8");
      const hasPlaceholder =
        text.includes("__SYNTROPY_API_HOST__") || text.includes("${SYNTROPY_API_BASE_URL}");
      expect({ rel, hasPlaceholder }).toEqual({ rel, hasPlaceholder: true });
    }
  });
});
