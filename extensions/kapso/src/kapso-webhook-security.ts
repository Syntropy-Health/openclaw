/**
 * Kapso / Meta WhatsApp Cloud API webhook signature (B-Kapso-1, slice 2).
 *
 * Meta signs inbound WhatsApp webhooks (forwarded by Kapso) with the
 * `X-Hub-Signature-256` header: `sha256=<hex>` where the hex is an HMAC-SHA256 of
 * the RAW request body keyed with the Meta **app secret** (our `KAPSO_APP_SECRET`,
 * sourced from the GTM Meta app). Validation MUST run over the raw body before
 * any parse/route, and the comparison is timing-safe.
 */

import crypto from "node:crypto";

/**
 * Verify the `X-Hub-Signature-256` header against the raw body using the app
 * secret. Returns false on an absent/malformed/mismatched signature.
 */
export function verifyXHubSignature256(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  return timingSafeEqualStr(signatureHeader, expected);
}

/** Constant-time string comparison (length-guarded to avoid a length-leak short-circuit). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison to keep timing constant, then fail.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
