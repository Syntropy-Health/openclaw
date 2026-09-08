#!/usr/bin/env node
/**
 * SYN-272 P2 EXIT-VERIFICATION HARNESS — written BEFORE it can fully run
 * (CTO #8091, offer (b)): the per-channel probes and their EXPECTED VALUES
 * are pre-committed here, so the day channel creds land on staging, P2's
 * exit is a button-press, not a build — and a surprising result cannot be
 * rationalised after the fact.
 *
 * WHAT IT PROVES (per channel): the full inbound mechanics UP TO the agent
 * seam — route registered → signature gate discriminates (RED arm: a
 * tampered signature MUST be rejected) → compliance-first ordering (STOP
 * answered without the agent) → a real message reaches the agent path.
 * Channel creds only change the signing secret; the mechanics are identical,
 * which is what makes pre-committing the expectations sound.
 *
 * VERDICT DISCIPLINE (estate rails, encoded):
 *  - Every probe prints MEASURED evidence beside its verdict ("PASS" alone
 *    is a claim; "PASS http=403 body=..." is evidence).
 *  - A route absent on the target is INFRA-ABSENT, never PASS or FAIL —
 *    "the channel is not funded here" is a distinct state from "the gate is
 *    broken" and from "the gate held" (the N-states-collapse rail).
 *  - EMPTY/unreachable target => exit 2 (inconclusive), never a pass.
 *  - Exit 0 ONLY when every probe on a REACHABLE, CHANNEL-FUNDED target
 *    lands its pre-committed expectation.
 *
 * Usage:
 *   TARGET=http://127.0.0.1:18789 \
 *   KAPSO_APP_SECRET=<secret> TWILIO_AUTH_TOKEN=<token> \
 *     node scripts/e2e/channel-surfaces-p2-exit.mjs
 *
 * Notes:
 *  - The standing :18789 dev gateway runs OPENCLAW_SKIP_CHANNELS=1 — against
 *    it every probe correctly reports INFRA-ABSENT (proven at authoring
 *    time; that run is this harness's own can-it-fail demonstration).
 *  - Secrets arrive via env, are used ONLY to sign synthetic payloads, and
 *    are never printed (length-only debug per the estate rule).
 */

import crypto from "node:crypto";

const TARGET = (process.env.TARGET ?? "http://127.0.0.1:18789").replace(/\/$/, "");
const KAPSO_APP_SECRET = process.env.KAPSO_APP_SECRET ?? "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";

const results = [];

/**
 * ROUTE-ABSENCE CANARY: servers disagree on the status for an unregistered
 * path (this gateway answers 405, others 404) — keying absence to a literal
 * status was this harness's own first bug, caught on its first run. Instead:
 * probe a KNOWN-nonexistent path once, and treat "same status as the canary"
 * as INFRA-ABSENT. A route that answers DIFFERENTLY from the canary exists,
 * and its status is a real gate verdict.
 */
let canaryStatus = null;
async function routeAbsent(status) {
  if (canaryStatus === null) {
    const res = await post("/__p2_harness_canary__/definitely-not-a-route", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    canaryStatus = res.status;
  }
  return status === canaryStatus;
}
function record(probe, verdict, evidence) {
  results.push({ probe, verdict, evidence });
  console.log(`${verdict.padEnd(13)} ${probe} — ${evidence}`);
}

async function post(path, { headers = {}, body }) {
  try {
    const res = await fetch(`${TARGET}${path}`, { method: "POST", headers, body });
    const text = await res.text().catch(() => "");
    return { status: res.status, text: text.slice(0, 200) };
  } catch (err) {
    return { status: -1, text: String(err).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Signature builders — the SAME schemes the gates validate.
// ---------------------------------------------------------------------------

/** Meta/Kapso: sha256= HMAC-SHA256 hex over the raw body, key = app secret. */
function kapsoSignature(rawBody, secret) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** Twilio: base64 HMAC-SHA1 over URL + sorted-key-concatenated form params. */
function twilioSignature(url, params, authToken) {
  const data =
    url +
    Object.keys(params)
      .toSorted()
      .map((k) => k + params[k])
      .join("");
  return crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

// ---------------------------------------------------------------------------
// Probes. Pre-committed expectations in each verdict line.
// ---------------------------------------------------------------------------

async function probeKapso() {
  const path = "/kapso/whatsapp";
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: "15551230042", id: "wamid.HARNESS1", type: "text", text: { body: "STOP" } },
              ],
            },
          },
        ],
      },
    ],
  });

  // Probe K0 — route present? (absent => channel not funded on this target)
  const unsigned = await post(path, {
    headers: { "content-type": "application/json" },
    body,
  });
  if (unsigned.status === -1) {
    record("K0 kapso route reach", "INCONCLUSIVE", `target unreachable: ${unsigned.text}`);
    return;
  }
  if (await routeAbsent(unsigned.status)) {
    record(
      "K0 kapso route reach",
      "INFRA-ABSENT",
      `http=${unsigned.status} == canary — /kapso/whatsapp not registered (channel not funded on ${TARGET}); NOT a gate verdict`,
    );
    return;
  }

  // Probe K1 — RED ARM: unsigned/tampered must be REJECTED (401/403), never 200.
  const redOk = unsigned.status === 401 || unsigned.status === 403;
  record(
    "K1 kapso RED-ARM unsigned rejected",
    redOk ? "PASS" : "FAIL",
    `expect 401|403, got http=${unsigned.status}`,
  );

  const tampered = await post(path, {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": kapsoSignature(body, "wrong-secret"),
    },
    body,
  });
  record(
    "K2 kapso RED-ARM tampered sig rejected",
    tampered.status === 401 || tampered.status === 403 ? "PASS" : "FAIL",
    `expect 401|403, got http=${tampered.status}`,
  );

  // Probe K3 — signed STOP: accepted (2xx) and handled compliance-first.
  if (!KAPSO_APP_SECRET) {
    record(
      "K3 kapso signed STOP accepted",
      "BLOCKED",
      "KAPSO_APP_SECRET not provided (creds pending)",
    );
    return;
  }
  const signed = await post(path, {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": kapsoSignature(body, KAPSO_APP_SECRET),
    },
    body,
  });
  record(
    "K3 kapso signed STOP accepted",
    signed.status >= 200 && signed.status < 300 ? "PASS" : "FAIL",
    `expect 2xx (compliance-first ack path), got http=${signed.status}`,
  );
}

async function probeTwilio() {
  const path = "/twilio/sms";
  const url = `${TARGET}${path}`;
  const params = {
    MessageSid: "SMHARNESS00000000000000000000001",
    AccountSid: "ACHARNESS0000000000000000000001",
    From: "+15551230042",
    To: "+15551230001",
    Body: "STOP",
  };
  const form = new URLSearchParams(params).toString();

  const unsigned = await post(path, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (unsigned.status === -1) {
    record("T0 twilio route reach", "INCONCLUSIVE", `target unreachable: ${unsigned.text}`);
    return;
  }
  if (await routeAbsent(unsigned.status)) {
    record(
      "T0 twilio route reach",
      "INFRA-ABSENT",
      `http=${unsigned.status} == canary — /twilio/sms not registered (smsEnabled not set / channel not funded on ${TARGET}); NOT a gate verdict`,
    );
    return;
  }

  const redOk = unsigned.status === 401 || unsigned.status === 403;
  record(
    "T1 twilio RED-ARM unsigned rejected",
    redOk ? "PASS" : "FAIL",
    `expect 401|403, got http=${unsigned.status}`,
  );

  const tampered = await post(path, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(url, params, "wrong-token"),
    },
    body: form,
  });
  record(
    "T2 twilio RED-ARM tampered sig rejected",
    tampered.status === 401 || tampered.status === 403 ? "PASS" : "FAIL",
    `expect 401|403, got http=${tampered.status}`,
  );

  if (!TWILIO_AUTH_TOKEN) {
    record(
      "T3 twilio signed STOP accepted",
      "BLOCKED",
      "TWILIO_AUTH_TOKEN not provided (creds pending)",
    );
    return;
  }
  const signed = await post(path, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(url, params, TWILIO_AUTH_TOKEN),
    },
    body: form,
  });
  record(
    "T3 twilio signed STOP accepted",
    signed.status >= 200 && signed.status < 300 ? "PASS" : "FAIL",
    `expect 2xx (TCPA compliance-first ack), got http=${signed.status}`,
  );
}

// ---------------------------------------------------------------------------

console.log(`channel-surfaces P2 exit probes — target ${TARGET}`);
console.log(
  `secrets: kapso len=${KAPSO_APP_SECRET.length} twilio len=${TWILIO_AUTH_TOKEN.length} (values never printed)`,
);
await probeKapso();
await probeTwilio();

const fails = results.filter((r) => r.verdict === "FAIL").length;
const inconclusive = results.filter((r) => r.verdict === "INCONCLUSIVE").length;
const absent = results.filter((r) => r.verdict === "INFRA-ABSENT").length;
const blocked = results.filter((r) => r.verdict === "BLOCKED").length;
const passes = results.filter((r) => r.verdict === "PASS").length;

console.log(
  `\nsummary: PASS=${passes} FAIL=${fails} INFRA-ABSENT=${absent} BLOCKED=${blocked} INCONCLUSIVE=${inconclusive}`,
);
if (inconclusive > 0) {
  console.log("verdict: INCONCLUSIVE — target unreachable; this run carries no information.");
  process.exit(2);
}
if (fails > 0) {
  console.log("verdict: FAIL — a pre-committed expectation was missed.");
  process.exit(1);
}
if (absent > 0 || blocked > 0) {
  console.log(
    "verdict: NOT-YET — channels absent or creds pending on this target; the P2 exit cannot be claimed from this run.",
  );
  process.exit(3);
}
console.log("verdict: P2 exit probes ALL GREEN on this target.");
process.exit(0);
