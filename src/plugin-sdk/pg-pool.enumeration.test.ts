/**
 * Deployment guard for plugin Postgres connections.
 *
 * openclaw's database is a dedicated schema in a shared Supabase project; its
 * role `openclaw_app` has CONNECTION LIMIT 20 (devex, 2026-09-28). The budget is
 * enforced at RUNTIME by `openPluginPool`: all plugins in a process share one
 * pool per URL, so a process holds at most `max` connections (<= the ceiling),
 * however many plugins, loops or wrappers open "their" pool.
 *
 * That guarantee holds only if nothing reaches the driver another way. This
 * test checks the source (TypeScript AST — comments, strings, template and regex
 * literals cannot fool it) for exactly that:
 *
 *  - the `postgres` driver binding is used only as `openPluginPool`'s first
 *    argument (or in type positions) — no direct call, `new`, rename, or pass-
 *    through;
 *  - no DB driver module is loaded any other way: no dynamic `import()`,
 *    `require()`, re-export, or a different driver package.
 *
 * And it pins the arithmetic that makes the ceiling safe.
 *
 * Scope limits, stated so they are not read as covered: it scans `.ts/.mts/.js/
 * .mjs` production files under `extensions/` and `src/` (tests, e2e helpers and
 * symlinks excluded); a driver package not in DB_DRIVER_MODULES is invisible.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_PG_POOL_MAX, PG_POOL_MAX_CEILING } from "./pg-pool.js";

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["extensions", "src"].map((d) => join(ROOT, d));

/** CONNECTION LIMIT on the Supabase role openclaw_app. */
const ROLE_CONNECTION_LIMIT = 20;
/** Connections kept free for operator / migration sessions. */
const OPERATOR_RESERVE = 2;
/** Gateway processes that can hold pools at once (old + new during a deploy). */
const CONCURRENT_PROCESSES = 2;

/** Database driver packages. Only `postgres`, only via openPluginPool. */
const DB_DRIVER_MODULES = new Set([
  "postgres",
  "pg",
  "pg-pool",
  "@neondatabase/serverless",
  "@vercel/postgres",
  "@supabase/postgres-js",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const p = join(dir, name);
    const st = lstatSync(p); // lstat: skip symlinks (some are dangling)
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

function inTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) {
      return true;
    }
    if (ts.isStatement(p)) {
      return false;
    }
  }
  return false;
}

function isOpenPluginPoolFirstArg(n: ts.Node): boolean {
  const call = n.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === n &&
    ((ts.isIdentifier(call.expression) && call.expression.text === "openPluginPool") ||
      (ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "openPluginPool"))
  );
}

/** Every way production code reaches a DB driver other than openPluginPool(postgres, …). */
function driverViolations(all: Parsed[]): string[] {
  const bad: string[] = [];
  for (const { file, sf } of all) {
    const bindings = new Set<string>();
    visit(sf, (n) => {
      const specText = (e: ts.Expression | undefined) =>
        e && ts.isStringLiteralLike(e) ? e.text : undefined;

      if (ts.isImportDeclaration(n)) {
        const mod = specText(n.moduleSpecifier);
        if (!mod || !DB_DRIVER_MODULES.has(mod)) {
          return;
        }
        const c = n.importClause;
        if (!c || c.isTypeOnly) {
          return;
        }
        if (mod !== "postgres") {
          bad.push(`${file}: imports driver "${mod}"`);
        } else if (c.name?.text !== "postgres") {
          bad.push(`${file}: imports postgres as ${c.name?.text}`);
        }
        if (
          c.namedBindings &&
          !(
            ts.isNamedImports(c.namedBindings) &&
            c.namedBindings.elements.every((e) => e.isTypeOnly)
          )
        ) {
          bad.push(`${file}: imports named/namespace bindings from "${mod}"`);
        }
        if (c.name) {
          bindings.add(c.name.text);
        }
      }
      if (ts.isExportDeclaration(n) && DB_DRIVER_MODULES.has(specText(n.moduleSpecifier) ?? "")) {
        bad.push(`${file}: re-exports "${specText(n.moduleSpecifier)}"`);
      }
      if (
        ts.isCallExpression(n) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
        DB_DRIVER_MODULES.has(specText(n.arguments[0]) ?? "")
      ) {
        bad.push(`${file}: dynamically loads "${specText(n.arguments[0])}"`);
      }
    });
    // Uses of the driver binding: only as openPluginPool's first argument, or in types.
    visit(sf, (n) => {
      if (!ts.isIdentifier(n) || !bindings.has(n.text)) {
        return;
      }
      const p = n.parent;
      if (p && (ts.isImportClause(p) || ts.isImportSpecifier(p))) {
        return;
      }
      if (p && ts.isPropertyAccessExpression(p) && p.name === n) {
        return;
      } // x.postgres (a property)
      if (inTypePosition(n) || isOpenPluginPoolFirstArg(n)) {
        return;
      }
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
      bad.push(`${file}:${line + 1}: driver "${n.text}" used outside openPluginPool`);
    });
  }
  return bad.toSorted();
}

describe("plugin Postgres connections — deployment guard", () => {
  const all = parseAll();

  it("no production code reaches a DB driver except via openPluginPool(postgres, …)", () => {
    expect(driverViolations(all)).toEqual([]);
  });

  it("budget: concurrent processes x pool ceiling fits the role limit with operator headroom", () => {
    expect(CONCURRENT_PROCESSES * PG_POOL_MAX_CEILING).toBeLessThanOrEqual(
      ROLE_CONNECTION_LIMIT - OPERATOR_RESERVE,
    );
    expect(DEFAULT_PG_POOL_MAX).toBeLessThanOrEqual(PG_POOL_MAX_CEILING);
  });

  it("control: the scan sees the real pool opens (an empty scan would pass vacuously)", () => {
    let opens = 0;
    for (const { sf } of all) {
      visit(sf, (n) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "openPluginPool"
        ) {
          opens += 1;
        }
      });
    }
    expect(opens).toBeGreaterThanOrEqual(6);
  });
});
