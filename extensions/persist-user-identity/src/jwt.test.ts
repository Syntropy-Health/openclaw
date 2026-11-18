/**
 * Auth endpoints carry pairing passcodes and an API token, so they must be
 * https without embedded credentials (plain http only for loopback), and the
 * requests made to them never follow redirects.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertSecureAuthEndpoints,
  lookupUserByName,
  verifyToken,
  verifyViaPasscode,
} from "./jwt.js";

const FIELDS = ["verifyEndpoint", "passcodeVerifyUrl", "userLookupUrl"] as const;

describe("assertSecureAuthEndpoints", () => {
  for (const field of FIELDS) {
    for (const bad of [
      "http://auth.example.test/verify",
      "   ",
      "",
      " https://auth.example.test/verify",
      "https://auth.example.test/verify ",
      "ftp://auth.example.test",
      "auth.example.test/verify",
      "https://user:secret@auth.example.test/verify",
      "https://user@auth.example.test/verify",
    ]) {
      test(`auth.${field}=${JSON.stringify(bad)} is refused, naming the setting`, () => {
        expect(() =>
          assertSecureAuthEndpoints({ mode: "passcode-endpoint", [field]: bad }),
        ).toThrow(`auth.${field}`);
      });
    }

    test(`auth.${field}: the refusal does not echo the value`, () => {
      let message = "";
      try {
        assertSecureAuthEndpoints({
          mode: "passcode-endpoint",
          [field]: "https://user:secret@auth.example.test/verify",
        });
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain(`auth.${field}`);
      expect(message).not.toContain("secret");
    });

    for (const ok of [
      "https://auth.example.test/api/ext/pairing/verify",
      "http://localhost:3000/verify",
      "http://127.0.0.1:3000/verify",
    ]) {
      test(`auth.${field}=${ok} is accepted`, () => {
        expect(() =>
          assertSecureAuthEndpoints({ mode: "passcode-endpoint", [field]: ok }),
        ).not.toThrow();
      });
    }
  }

  test("absent endpoints are not an error (the mode decides which are needed)", () => {
    expect(() => assertSecureAuthEndpoints({ mode: "jwt-hs256", jwtSecret: "x" })).not.toThrow();
    expect(() => assertSecureAuthEndpoints(undefined)).not.toThrow();
  });
});

describe("auth requests never follow redirects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown) {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("verify-endpoint request sets redirect: error", async () => {
    const fetchMock = stubFetch({});
    await verifyToken("tok", {
      mode: "verify-endpoint",
      verifyEndpoint: "https://a.example.test/v",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  test("passcode request sets redirect: error", async () => {
    const fetchMock = stubFetch({});
    await verifyViaPasscode("123456", undefined, {
      mode: "passcode-endpoint",
      passcodeVerifyUrl: "https://a.example.test/p",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  test("user lookup request sets redirect: error", async () => {
    const fetchMock = stubFetch([]);
    await lookupUserByName("Ada", {
      mode: "passcode-endpoint",
      userLookupUrl: "https://a.example.test/u",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
