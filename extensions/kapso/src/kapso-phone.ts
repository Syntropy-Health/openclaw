/**
 * Kapso phone-number-id resolution (B-Kapso-1).
 *
 * The send endpoint is phone-number-id based, but provisioning gives us a WABA
 * (business account) id + config id, not the bare phone-number-id. This module
 * derives it: `GET {baseUrl}/{businessAccountId}/phone_numbers` (Cloud API via
 * the Kapso Meta-proxy, `X-API-Key` auth) → the first number's id. An explicit
 * `phoneNumberId` in config always wins (no lookup).
 */

import { type ResolvedKapsoConfig } from "./kapso-config.js";
import { type KapsoFetch } from "./kapso-send.js";

/** Fetch the first WABA phone-number-id via the Cloud API. Returns null on any failure. */
export async function fetchKapsoPhoneNumberId(params: {
  apiKey: string;
  baseUrl: string;
  businessAccountId: string;
  fetchImpl?: KapsoFetch;
}): Promise<string | null> {
  const doFetch = params.fetchImpl ?? fetch;
  const url = `${params.baseUrl.replace(/\/$/, "")}/${params.businessAccountId}/phone_numbers`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { "X-API-Key": params.apiKey },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  try {
    const text = await response.text();
    const data = (text ? JSON.parse(text) : {}) as { data?: Array<{ id?: string }> };
    return data.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective phone-number-id for a config: the explicit
 * `phoneNumberId` if set, else derived from `businessAccountId`. Returns null
 * when neither is available/resolvable (channel stays inert for send).
 */
export async function resolveKapsoPhoneNumberId(
  config: ResolvedKapsoConfig,
  fetchImpl?: KapsoFetch,
): Promise<string | null> {
  if (config.phoneNumberId) return config.phoneNumberId;
  if (!config.businessAccountId) return null;
  return fetchKapsoPhoneNumberId({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    businessAccountId: config.businessAccountId,
    fetchImpl,
  });
}
