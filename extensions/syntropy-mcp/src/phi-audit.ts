/**
 * PhiAuditClient — the append-only PHI audit write openclaw MUST perform BEFORE
 * any `phi`-gated tool result returns (ADR-0001, devex PIN 3, `572b90520`). This
 * is a SEPARATE hard gate from `phi_cleared`: even a cleared admin does not get a
 * PHI result unless the audit durably persists first.
 *
 * Transport (pinned): `POST /api/admin/phi-audit`, authenticated with an INTERNAL
 * SERVICE TOKEN (NOT the admin key), returns **201** on durable insert. Anything
 * else — non-2xx, timeout, network error — → `{ ok: false }` and the caller
 * (the guard) DENIES the tool. The record is PHI-FREE: identifiers only.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** Identifiers only — NEVER health content/values. */
export type PhiAuditRecord = {
  admin_subject: string; // calling admin's clerk_user_id
  target_clerk_id: string; // whose records are being read
  tool: string; // surfaced tool slug
  ts: string; // ISO-8601
};

export type PhiAuditWriteResult = { ok: boolean };

export type PhiAuditClientOptions = {
  /** SJ-owned endpoint, e.g. `https://<sj>/api/admin/phi-audit`. */
  endpoint: string;
  /** Internal service token (Infisical-sourced). NOT the admin key. */
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: { warn?: (m: string) => void };
};

export class PhiAuditClient {
  private readonly endpoint: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: PhiAuditClientOptions["logger"];

  constructor(opts: PhiAuditClientOptions) {
    this.endpoint = opts.endpoint;
    this.serviceToken = opts.serviceToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger;
  }

  /**
   * Write one audit record. Resolves `{ ok: true }` ONLY on HTTP 201 (durable
   * insert). Every other outcome is `{ ok: false }` — fail-closed, the guard must
   * then DENY the tool (the result never returns).
   */
  async write(record: PhiAuditRecord): Promise<PhiAuditWriteResult> {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.serviceToken}`,
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 201) {
        return { ok: true };
      }
      this.logger?.warn?.(`phi-audit: non-201 (${res.status}) → DENY the phi tool`);
      return { ok: false };
    } catch {
      this.logger?.warn?.("phi-audit: write failed (timeout/network) → DENY the phi tool");
      return { ok: false };
    }
  }
}
