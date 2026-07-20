import { describe, expect, it } from "vitest";
import { assertClerkConfigAllOrNone } from "./auth.js";

const E = (o: Record<string, string> = {}): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

/**
 * G-lane [G3] / A&D §7 should-fix (ii): the 3 OPENCLAW_CLERK_* must be all-or-none.
 * A partial config would silently disable Clerk verify (net-401 on the mobile
 * channel) — the boot-assert fails loudly instead.
 */
describe("assertClerkConfigAllOrNone (G-lane [G3] boot-assert)", () => {
  it("passes when Clerk is fully unconfigured (0 of 3) — Clerk OFF", () => {
    expect(() => assertClerkConfigAllOrNone(undefined, E())).not.toThrow();
  });

  it("passes when all three env vars are set (3 of 3) — Clerk ON", () => {
    expect(() =>
      assertClerkConfigAllOrNone(
        undefined,
        E({
          OPENCLAW_CLERK_JWKS_URL: "https://clerk.shrinelongevity.com/.well-known/jwks.json",
          OPENCLAW_CLERK_ISSUER: "clerk.shrinelongevity.com",
          OPENCLAW_CLERK_AUDIENCE: "openclaw",
        }),
      ),
    ).not.toThrow();
  });

  it("★ THROWS on a partial env config (1 of 3) — silent-disable guard", () => {
    expect(() =>
      assertClerkConfigAllOrNone(undefined, E({ OPENCLAW_CLERK_JWKS_URL: "https://x/jwks.json" })),
    ).toThrow(/partially configured/);
  });

  it("★ THROWS on a partial env config (2 of 3 — missing audience)", () => {
    expect(() =>
      assertClerkConfigAllOrNone(
        undefined,
        E({
          OPENCLAW_CLERK_JWKS_URL: "https://x/jwks.json",
          OPENCLAW_CLERK_ISSUER: "clerk.shrinelongevity.com",
        }),
      ),
    ).toThrow(/OPENCLAW_CLERK_AUDIENCE|partially configured/);
  });

  it("config object counts too, and mixes with env (config precedence, same as resolveClerkAuth)", () => {
    // config supplies 2, env supplies the 3rd → all-3 → OK
    expect(() =>
      assertClerkConfigAllOrNone(
        { jwksUrl: "https://x/jwks.json", issuer: "clerk.shrinelongevity.com" },
        E({ OPENCLAW_CLERK_AUDIENCE: "openclaw" }),
      ),
    ).not.toThrow();
    // config supplies only 1, env none → partial → THROW
    expect(() => assertClerkConfigAllOrNone({ jwksUrl: "https://x/jwks.json" }, E())).toThrow(
      /partially configured/,
    );
  });

  it("whitespace-only values do not count as configured", () => {
    expect(() =>
      assertClerkConfigAllOrNone(
        undefined,
        E({
          OPENCLAW_CLERK_JWKS_URL: "   ",
          OPENCLAW_CLERK_ISSUER: "clerk.shrinelongevity.com",
          OPENCLAW_CLERK_AUDIENCE: "openclaw",
        }),
      ),
    ).toThrow(/partially configured/); // only 2 real → partial
  });
});
