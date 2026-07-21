/**
 * Kapso dev-number E2E (slice-4 gate item 3 — RUN-READY harness).
 *
 * Exercises the REAL Kapso Cloud API path end-to-end against the dev WhatsApp
 * number: config resolution → phone-number-id lookup → webhook HMAC self-test →
 * one LIVE outbound text (opt-out-guard shape verified locally first).
 *
 * NO SECRETS IN CODE — credentials are read from the environment AT EXECUTION.
 * Canonical invocation (Infisical project 589d1e3b…, env dev):
 *
 *   RUN_KAPSO_E2E=1 KAPSO_E2E_TO=+15551234567 \
 *     infisical run --env=dev --path=/channels/kapso -- \
 *     pnpm exec tsx scripts/e2e/kapso-dev-number.ts
 *
 * Safety: refuses to run without RUN_KAPSO_E2E=1 (this sends a REAL WhatsApp
 * message) and without an explicit +E164 KAPSO_E2E_TO target. Exit 0 = all
 * steps PASS; non-zero = the failing step is printed. Principal go (gate item
 * 4) is still required before any live cutover — this harness only proves the
 * transport works on the DEV number.
 */

import { resolveKapsoConfig } from "../../extensions/kapso/src/kapso-config.js";
import { resolveKapsoPhoneNumberId } from "../../extensions/kapso/src/kapso-phone.js";
import { sendKapsoMessage } from "../../extensions/kapso/src/kapso-send.js";
import { verifyXHubSignature256 } from "../../extensions/kapso/src/kapso-webhook-security.js";
import { parseKapsoInbounds } from "../../extensions/kapso/src/kapso-webhook.js";

type Step = { name: string; run: () => Promise<string> };

function fail(msg: string): never {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.env.RUN_KAPSO_E2E !== "1") {
    fail("refusing to run: set RUN_KAPSO_E2E=1 (this sends a REAL WhatsApp message)");
  }
  const to = process.env.KAPSO_E2E_TO?.trim() ?? "";
  if (!/^\+[1-9]\d{1,14}$/.test(to)) {
    fail("KAPSO_E2E_TO must be the dev number in +E164 form (e.g. +15551234567)");
  }

  // Resolved once; every step below reuses it.
  const config = resolveKapsoConfig(undefined, process.env);
  if (!config) {
    fail(
      "Kapso config is not credential-complete — run under `infisical run --env=dev --path=/channels/kapso` " +
        "(needs KAPSO_API_KEY, KAPSO_APP_SECRET, and KAPSO_PHONE_NUMBER_ID or KAPSO_BUSINESS_ACCOUNT_ID)",
    );
  }

  let phoneNumberId = "";

  const steps: Step[] = [
    {
      name: "1. config resolution (credential-complete, fail-closed contract)",
      run: async () => `baseUrl=${config.baseUrl} inbound=${config.inbound}`,
    },
    {
      name: "2. phone-number-id (explicit or derived from the WABA id — live API)",
      run: async () => {
        const pnid = await resolveKapsoPhoneNumberId(config);
        if (!pnid) {
          throw new Error("phone-number-id unresolved (check KAPSO_BUSINESS_ACCOUNT_ID / API key)");
        }
        phoneNumberId = pnid;
        return `phoneNumberId=${pnid}`;
      },
    },
    {
      name: "3. webhook x-hub-signature-256 self-test (local HMAC roundtrip + parse)",
      run: async () => {
        const raw = JSON.stringify({
          entry: [
            {
              changes: [
                {
                  value: {
                    messages: [{ from: to.slice(1), id: "wamid.E2E", text: { body: "ping" } }],
                  },
                },
              ],
            },
          ],
        });
        const { createHmac } = await import("node:crypto");
        const sig = `sha256=${createHmac("sha256", config.appSecret).update(raw, "utf8").digest("hex")}`;
        if (!verifyXHubSignature256(raw, sig, config.appSecret)) {
          throw new Error("HMAC roundtrip failed — appSecret wiring broken");
        }
        const [inbound] = parseKapsoInbounds(JSON.parse(raw));
        if (inbound?.from !== to) {
          throw new Error(`parse/normalize mismatch: got ${inbound?.from}, want ${to}`);
        }
        return "signature + parse/+E164-normalize OK";
      },
    },
    {
      name: "4. LIVE outbound text to the dev number (Cloud API via Kapso)",
      run: async () => {
        const r = await sendKapsoMessage({
          config,
          phoneNumberId,
          to,
          body: `OpenClaw Kapso E2E ✅ ${new Date().toISOString()}`,
        });
        if (!r.ok) {
          throw new Error(`send failed (status ${r.status ?? "n/a"}): ${r.error}`);
        }
        return `sid=${r.sid}`;
      },
    },
  ];

  console.log(`Kapso dev-number E2E → ${to}\n`);
  for (const step of steps) {
    try {
      const detail = await step.run();
      console.log(`✅ ${step.name} — ${detail}`);
    } catch (err) {
      fail(`${step.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(
    "\n🟢 E2E PASS. Manual follow-ups: (a) confirm the message arrived on the dev phone; " +
      "(b) reply STOP from the phone and verify the webhook records the opt-out + acks; " +
      "(c) reply START to restore. Gate item 4 (principal go) still required before cutover.",
  );
}

void main();
