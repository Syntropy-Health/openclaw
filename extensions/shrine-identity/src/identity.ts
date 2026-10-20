import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** One shipped identity text, keyed by its path relative to the shrine dir. */
export type IdentityFile = { rel: string; sha256: string };

export const sha256Hex = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

/**
 * The identity version: a short hash over every shipped text's relative path and content hash.
 * It depends only on content, so one image gives one version on every machine, and the CEO
 * co-sign record (COSIGN.json) yields the same value for a live compare.
 */
export function identityVersion(files: IdentityFile[]): string {
  const lines = files
    .map((f) => `${f.rel} ${f.sha256}`)
    .toSorted()
    .join("\n");
  return sha256Hex(lines).slice(0, 12);
}

/** Every *.md under workspace/ and layers/ in the shrine dir, with its content hash. */
export function listIdentityFiles(shrineDir: string): IdentityFile[] {
  const out: IdentityFile[] = [];
  for (const sub of ["workspace", "layers"]) {
    const dir = path.join(shrineDir, sub);
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir).toSorted()) {
      if (!name.endsWith(".md")) {
        continue;
      }
      out.push({ rel: `${sub}/${name}`, sha256: sha256Hex(fs.readFileSync(path.join(dir, name))) });
    }
  }
  return out;
}

/** Platform layers by channel id: layers/<channel>.md. Blank files are ignored. */
export function loadLayers(shrineDir: string): Map<string, string> {
  const layers = new Map<string, string>();
  const dir = path.join(shrineDir, "layers");
  if (!fs.existsSync(dir)) {
    return layers;
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), "utf8").trim();
    if (text) {
      layers.set(name.slice(0, -3).toLowerCase(), text);
    }
  }
  return layers;
}

/** The before_agent_start result for a channel: ONLY a systemPrompt, or nothing. */
export function layerResultFor(
  layers: Map<string, string>,
  channel: string | undefined,
): { systemPrompt: string } | undefined {
  const key = (channel ?? "").trim().toLowerCase();
  const text = key ? layers.get(key) : undefined;
  return text ? { systemPrompt: text } : undefined;
}

type AgentsConfig = {
  defaults?: { workspace?: string };
  list?: Array<{ id?: string; default?: boolean; workspace?: string }>;
};

/**
 * Problems that would stop the identity from applying, checked at boot so they are loud:
 * the default agent's workspace (an `agents.list` override wins over `agents.defaults`) must be
 * `<shrineDir>/workspace`, and any other configured agent gets no Sh'rine persona.
 * Mirrors resolveAgentWorkspaceDir's precedence (src/agents/agent-scope.ts).
 */
export function identityConfigProblems(
  agents: AgentsConfig | undefined,
  shrineDir: string,
): string[] {
  const expected = path.join(shrineDir, "workspace");
  const list = agents?.list ?? [];
  const defaultEntry = list.find((a) => a?.default) ?? list[0];
  const effective = defaultEntry?.workspace?.trim() || agents?.defaults?.workspace?.trim() || "";
  const problems: string[] = [];
  if (path.resolve(effective || "/nonexistent") !== path.resolve(expected)) {
    problems.push(
      defaultEntry?.workspace?.trim()
        ? "default agent's agents.list workspace overrides the Sh'rine identity workspace"
        : "agents.defaults.workspace is not the Sh'rine identity workspace",
    );
  }
  const others = list.filter((a) => a && a !== defaultEntry).length;
  if (others > 0) {
    problems.push(
      `${others} non-default agent(s) configured: they run without the Sh'rine persona`,
    );
  }
  return problems;
}
