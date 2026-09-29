/**
 * Guard for the connection budget in pg-pool.ts. The budget is a property of
 * POOL INSTANCES, not of files: a plugin can open a pool by calling another
 * plugin's factory (kapso reuses twilio's createSmsPgClient), which a per-file
 * count of `postgres(` misses. So this test enumerates every site that OPENS a
 * pool — a direct `postgres(` call outside a factory, or a call to a pool
 * factory — and asserts:
 *
 *  1. the set of opening sites is exactly the enumerated list (a new pool fails
 *     until it is added here, which forces the budget check below to be re-read);
 *  2. no opening site hardcodes a numeric `max:` (all go through
 *     resolvePgPoolMax / OPENCLAW_PG_POOL_MAX);
 *  3. instances x DEFAULT_PG_POOL_MAX fits the openclaw_app CONNECTION LIMIT with
 *     operator headroom — the arithmetic itself, not a comment about it.
 *
 * It reads source deliberately: where pools are opened IS a source property.
 * Comments are stripped before matching so prose mentioning `postgres(` or a
 * factory name can neither satisfy nor trip it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PG_POOL_MAX } from "./pg-pool.js";

const ROOT = join(import.meta.dirname, "..", "..");
const EXT = join(ROOT, "extensions");

/** CONNECTION LIMIT on the Supabase role openclaw_app (devex, 2026-09-28). */
const ROLE_CONNECTION_LIMIT = 20;
/** Connections kept free for operator / migration sessions. */
const OPERATOR_RESERVE = 2;

/** Files that DEFINE a pool factory: their inner `postgres(` is not an instance. */
const FACTORY_FILES = new Set([
  "extensions/persist-postgres/src/db.ts",
  "extensions/persist-user-identity/src/db.ts",
  "extensions/twilio/src/db.ts",
]);
const FACTORY_CALL = /\b(createPgClient|createSmsPgClient)\(/g;

/** Every site that opens a pool against DATABASE_URL (enumerated 2026-09-28). */
const EXPECTED_OPENING_SITES = [
  "extensions/auth-memory-gate/src/index.ts",
  "extensions/kapso/src/index.ts",
  "extensions/memory-graphiti/index.ts",
  "extensions/persist-postgres/src/index.ts",
  "extensions/persist-user-identity/src/index.ts",
  "extensions/syntropy/src/index.ts",
  "extensions/twilio/src/index.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.e2e\.|\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

type Site = { file: string; call: string };

function openingSites(): Site[] {
  const sites: Site[] = [];
  for (const f of walk(EXT)) {
    const file = relative(ROOT, f);
    const code = stripComments(readFileSync(f, "utf8"));
    if (!FACTORY_FILES.has(file)) {
      for (const m of code.matchAll(/\bpostgres\(([^;]*?)\)/g)) {
        sites.push({ file, call: m[0] });
      }
    }
    for (const m of code.matchAll(FACTORY_CALL)) {
      const line = code.slice(m.index, code.indexOf("\n", m.index));
      // `export function createPgClient(` is the definition, not an instance.
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 16), m.index))) {
        continue;
      }
      sites.push({ file, call: line.trim() });
    }
  }
  return sites;
}

function factoryDefinitions(): Site[] {
  return [...FACTORY_FILES].map((file) => {
    const code = stripComments(readFileSync(join(ROOT, file), "utf8"));
    const m = code.match(/\bpostgres\(([^;]*?)\)/);
    return { file, call: m ? m[0] : "<no postgres() call>" };
  });
}

describe("DATABASE_URL pool budget (pg-pool guard)", () => {
  it("the pool-opening sites are exactly the enumerated seven", () => {
    const files = openingSites()
      .map((s) => s.file)
      .toSorted();
    expect(files).toEqual([...EXPECTED_OPENING_SITES].toSorted());
  });

  it("no opening site or factory hardcodes a numeric max (named OR positional)", () => {
    const literal = [...openingSites(), ...factoryDefinitions()].filter(
      (s) =>
        // named: postgres(url, { max: 5 })
        /\bmax\s*:\s*\d/.test(s.call) ||
        // positional: createSmsPgClient(url, 3) — the factory's size argument
        /\b(createPgClient|createSmsPgClient)\([^)]*,\s*\d+\s*\)/.test(s.call),
    );
    expect(literal).toEqual([]);
  });

  it("instances x default fits the role limit with operator headroom", () => {
    const instances = openingSites().length;
    expect(instances * DEFAULT_PG_POOL_MAX).toBeLessThanOrEqual(
      ROLE_CONNECTION_LIMIT - OPERATOR_RESERVE,
    );
  });

  it("control: the scan found the factories and a non-empty site list", () => {
    expect(factoryDefinitions().every((s) => s.call.startsWith("postgres("))).toBe(true);
    expect(openingSites().length).toBe(EXPECTED_OPENING_SITES.length);
  });
});
