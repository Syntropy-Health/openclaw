/**
 * Deployment budget guard for plugin Postgres pools.
 *
 * openclaw's database is a dedicated schema in a shared Supabase project; its
 * role `openclaw_app` has CONNECTION LIMIT 20 (devex, 2026-09-28). The total
 * connections the gateway can open is (pool instances) x (per-pool max), and
 * during a deploy two processes can overlap. This test keeps that product
 * inside the limit by making two things true of the source:
 *
 *  1. Nothing opens a pool except through `openPluginPool` — no production code
 *     calls the driver directly, aliases it, or uses a different driver. That
 *     makes "a pool that forgot its max" (driver default 10) IMPOSSIBLE rather
 *     than something a pattern has to spot.
 *  2. The number of pool INSTANCES is exactly the enumerated list. Instances are
 *     direct `openPluginPool(` calls plus calls to FACTORIES — functions whose
 *     body calls `openPluginPool(`, discovered from the source rather than kept
 *     by hand (kapso opens a pool by calling twilio's factory).
 *
 * It parses each file with the TypeScript compiler and inspects the AST, so
 * comments, strings, template literals and regex literals can neither satisfy
 * nor hide a check (a text scanner was tried first and a regex literal
 * containing a quote character made it blank out a real call).
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_PG_POOL_MAX } from "./pg-pool.js";

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["extensions", "src"].map((d) => join(ROOT, d));
const SELF = "src/plugin-sdk/pg-pool.ts";

/** CONNECTION LIMIT on the Supabase role openclaw_app. */
const ROLE_CONNECTION_LIMIT = 20;
/** Connections kept free for operator / migration sessions. */
const OPERATOR_RESERVE = 2;
/** Gateway processes that can hold pools at once (old + new during a deploy). */
const CONCURRENT_PROCESSES = 2;

/** Pool instances (enumerated 2026-09-28), one entry per opening call site. */
const EXPECTED_INSTANCES = [
  "extensions/auth-memory-gate/src/index.ts",
  "extensions/kapso/src/index.ts",
  "extensions/memory-graphiti/index.ts",
  "extensions/persist-postgres/src/index.ts",
  "extensions/persist-user-identity/src/index.ts",
  "extensions/syntropy/src/index.ts",
  "extensions/twilio/src/index.ts",
].toSorted();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const p = join(dir, name);
    // lstat, not stat: the tree carries symlinks (some dangling, e.g. a CLAUDE.md
    // alias) and a symlinked file is scanned at its real path if it is in-tree.
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.e2e\.|\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

type Parsed = { file: string; sf: ts.SourceFile };

function parseAll(): Parsed[] {
  return SCAN_DIRS.flatMap((d) => walk(d)).map((f) => ({
    file: relative(ROOT, f),
    sf: ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true),
  }));
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

/** Name a call is made through: `foo(...)` -> "foo", `a.b.foo(...)` -> "foo". */
function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) {
    return e.text;
  }
  if (ts.isPropertyAccessExpression(e)) {
    return e.name.text;
  }
  return undefined;
}

function callsNamed(node: ts.Node, name: string): number {
  let n = 0;
  visit(node, (x) => {
    if (ts.isCallExpression(x) && calleeName(x) === name) {
      n += 1;
    }
  });
  return n;
}

/** Functions (declarations or const = function/arrow) whose body calls openPluginPool. */
function findFactories(all: Parsed[]): { name: string; file: string; node: ts.Node }[] {
  const found: { name: string; file: string; node: ts.Node }[] = [];
  for (const { file, sf } of all) {
    if (file === SELF) {
      continue;
    }
    visit(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body && callsNamed(n.body, "openPluginPool")) {
        found.push({ name: n.name.text, file, node: n });
      } else if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
        callsNamed(n.initializer.body, "openPluginPool")
      ) {
        found.push({ name: n.name.text, file, node: n });
      }
    });
  }
  return found;
}

function poolInstances(all: Parsed[]): string[] {
  const factories = findFactories(all);
  const names = new Set(factories.map((f) => f.name));
  const insideFactory = (n: ts.Node) =>
    factories.some(
      (f) =>
        n.pos >= f.node.pos && n.end <= f.node.end && f.node.getSourceFile() === n.getSourceFile(),
    );
  const instances: string[] = [];
  for (const { file, sf } of all) {
    if (file === SELF) {
      continue;
    }
    visit(sf, (n) => {
      if (!ts.isCallExpression(n)) {
        return;
      }
      const name = calleeName(n);
      if (name === "openPluginPool" && !insideFactory(n)) {
        instances.push(file);
      } else if (name && names.has(name)) {
        instances.push(file);
      }
    });
  }
  return instances.toSorted();
}

describe("plugin Postgres pools — deployment budget guard", () => {
  const all = parseAll();

  it("no production code calls the postgres driver directly", () => {
    const direct: string[] = [];
    for (const { file, sf } of all) {
      if (callsNamed(sf, "postgres") > 0) {
        direct.push(file);
      }
    }
    expect(direct).toEqual([]);
  });

  it("the driver is only ever imported under its own name, and no other driver is used", () => {
    const bad: string[] = [];
    for (const { file, sf } of all) {
      visit(sf, (n) => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
          const mod = n.moduleSpecifier.text;
          if (mod === "pg") {
            bad.push(`${file}: imports "pg"`);
          }
          if (mod !== "postgres" || !n.importClause || n.importClause.isTypeOnly) {
            return;
          }
          const c = n.importClause;
          if (c.name && c.name.text !== "postgres") {
            bad.push(`${file}: imports postgres as ${c.name.text}`);
          }
          if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
            bad.push(`${file}: imports postgres as namespace ${c.namedBindings.name.text}`);
          }
        }
        if (
          ts.isCallExpression(n) &&
          calleeName(n) === "require" &&
          n.arguments[0] &&
          ts.isStringLiteral(n.arguments[0]) &&
          (n.arguments[0].text === "postgres" || n.arguments[0].text === "pg")
        ) {
          bad.push(`${file}: require()s ${n.arguments[0].text}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it("pool instances are exactly the enumerated seven", () => {
    expect(poolInstances(all)).toEqual(EXPECTED_INSTANCES);
  });

  it("budget: processes x instances x default max fits the role limit with operator headroom", () => {
    const total = CONCURRENT_PROCESSES * poolInstances(all).length * DEFAULT_PG_POOL_MAX;
    expect(total).toBeLessThanOrEqual(ROLE_CONNECTION_LIMIT - OPERATOR_RESERVE);
  });

  it("control: the factories are discovered, not assumed", () => {
    expect(
      findFactories(all)
        .map((f) => `${f.file}#${f.name}`)
        .toSorted(),
    ).toEqual([
      "extensions/persist-postgres/src/db.ts#createPgClient",
      "extensions/persist-user-identity/src/db.ts#createPgClient",
      "extensions/twilio/src/db.ts#createSmsPgClient",
    ]);
  });
});
