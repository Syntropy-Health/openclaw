import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  applyApiCors,
  resolveAllowedOrigin,
  resolveCorsAllowedOrigins,
} from "./cors.js";

function fakeReq(method: string, origin?: string): IncomingMessage {
  return { method, headers: origin ? { origin } : {} } as unknown as IncomingMessage;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let ended = false;
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    end: () => {
      ended = true;
    },
  };
  return { res: res as unknown as ServerResponse, headers, get ended() {
    return ended;
  } };
}

describe("resolveCorsAllowedOrigins", () => {
  it("unions config + env (comma-separated), trims, dedups, strips trailing slash", () => {
    const out = resolveCorsAllowedOrigins({
      configOrigins: ["http://localhost:8550/", " https://app.example.com "],
      env: { OPENCLAW_HTTP_CORS_ORIGINS: "http://localhost:8550, https://test.example.com" } as never,
    });
    expect(out).toContain("http://localhost:8550");
    expect(out).toContain("https://app.example.com");
    expect(out).toContain("https://test.example.com");
    expect(out.filter((o) => o === "http://localhost:8550")).toHaveLength(1); // dedup
  });

  it("empty by default (no config, no env) → no origins", () => {
    expect(resolveCorsAllowedOrigins({ env: {} as never })).toEqual([]);
  });

  it("preserves '*' literal", () => {
    expect(resolveCorsAllowedOrigins({ configOrigins: ["*"], env: {} as never })).toEqual(["*"]);
  });
});

describe("resolveAllowedOrigin", () => {
  it("echoes an exact-match origin", () => {
    expect(resolveAllowedOrigin("http://localhost:8550", ["http://localhost:8550"])).toBe(
      "http://localhost:8550",
    );
  });
  it("returns null for a non-allowlisted origin", () => {
    expect(resolveAllowedOrigin("https://evil.example", ["http://localhost:8550"])).toBeNull();
  });
  it("returns null when no Origin header (native client)", () => {
    expect(resolveAllowedOrigin(undefined, ["http://localhost:8550"])).toBeNull();
  });
  it("returns null when allowlist empty (CORS off)", () => {
    expect(resolveAllowedOrigin("http://localhost:8550", [])).toBeNull();
  });
  it("'*' echoes the request origin (not a literal '*')", () => {
    expect(resolveAllowedOrigin("https://app.example.com", ["*"])).toBe("https://app.example.com");
  });
});

describe("applyApiCors", () => {
  it("sets ACAO + Vary + preflight headers for an allowed origin", () => {
    const { res, headers } = fakeRes();
    const out = applyApiCors(fakeReq("POST", "http://localhost:8550"), res, ["http://localhost:8550"]);
    expect(out.preflight).toBe(false);
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:8550");
    expect(headers["vary"]).toBe("Origin");
    expect(headers["access-control-allow-methods"]).toContain("POST");
    expect(headers["access-control-allow-headers"]).toContain("authorization");
  });

  it("emits NO CORS headers for a disallowed origin", () => {
    const { res, headers } = fakeRes();
    applyApiCors(fakeReq("POST", "https://evil.example"), res, ["http://localhost:8550"]);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("emits NO CORS headers for a native client (no Origin)", () => {
    const { res, headers } = fakeRes();
    applyApiCors(fakeReq("POST", undefined), res, ["http://localhost:8550"]);
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("flags OPTIONS as a preflight (allowed origin → headers set)", () => {
    const { res, headers } = fakeRes();
    const out = applyApiCors(fakeReq("OPTIONS", "http://localhost:8550"), res, [
      "http://localhost:8550",
    ]);
    expect(out.preflight).toBe(true);
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:8550");
  });
});
