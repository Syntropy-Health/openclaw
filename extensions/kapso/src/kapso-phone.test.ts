import { describe, expect, it, vi } from "vitest";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import { fetchKapsoPhoneNumberId, resolveKapsoPhoneNumberId } from "./kapso-phone.js";

const BASE = {
  apiKey: "kapso_key",
  baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
  businessAccountId: "1312147934010664",
};

function okFetch(payload: unknown, capture?: (url: string, init: RequestInit) => void) {
  return vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("fetchKapsoPhoneNumberId", () => {
  it("GETs {baseUrl}/{businessAccountId}/phone_numbers with X-API-Key and returns the first id", async () => {
    let seenUrl = "";
    let apiKeyHeader = "";
    const fetchImpl = okFetch({ data: [{ id: "PN_FIRST" }, { id: "PN_SECOND" }] }, (u, init) => {
      seenUrl = u;
      apiKeyHeader = (init.headers as Record<string, string>)["X-API-Key"];
    });
    const id = await fetchKapsoPhoneNumberId({ ...BASE, fetchImpl });
    expect(seenUrl).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/1312147934010664/phone_numbers");
    expect(apiKeyHeader).toBe("kapso_key");
    expect(id).toBe("PN_FIRST");
  });

  it("returns null on HTTP error / network throw / empty data", async () => {
    const httpErr = vi.fn(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;
    expect(await fetchKapsoPhoneNumberId({ ...BASE, fetchImpl: httpErr })).toBeNull();

    const threw = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await fetchKapsoPhoneNumberId({ ...BASE, fetchImpl: threw })).toBeNull();

    const empty = okFetch({ data: [] });
    expect(await fetchKapsoPhoneNumberId({ ...BASE, fetchImpl: empty })).toBeNull();
  });
});

describe("resolveKapsoPhoneNumberId", () => {
  const cfg = (over: Partial<ResolvedKapsoConfig>): ResolvedKapsoConfig => ({
    apiKey: "kapso_key",
    baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
    appSecret: "s",
    inbound: "pairing",
    allowFrom: [],
    ...over,
  });

  it("uses the explicit phoneNumberId WITHOUT any lookup", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const id = await resolveKapsoPhoneNumberId(cfg({ phoneNumberId: "PN_EXPLICIT" }), fetchImpl);
    expect(id).toBe("PN_EXPLICIT");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("derives from businessAccountId when no explicit phoneNumberId", async () => {
    const fetchImpl = okFetch({ data: [{ id: "PN_DERIVED" }] });
    const id = await resolveKapsoPhoneNumberId(
      cfg({ businessAccountId: "1312147934010664" }),
      fetchImpl,
    );
    expect(id).toBe("PN_DERIVED");
  });

  it("returns null when neither is available", async () => {
    expect(await resolveKapsoPhoneNumberId(cfg({}))).toBeNull();
  });
});
