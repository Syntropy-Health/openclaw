/**
 * chat-auth-qa-preview — stand up a LOCAL, QA-previewable openclaw chat gateway
 * with the P1 chat-auth surface (Clerk-JWT verification + τ-metering) wired on,
 * so the integrated mobile flow (a Clerk-JWT'd `POST /v1/responses` → SSE stream)
 * can be exercised end-to-end without a deploy.
 *
 * It runs the REAL gateway (`startGatewayServer`) — the same code path prod uses.
 * The only thing faked is the Clerk JWKS source: by default this script mints a
 * throwaway RSA keypair, serves its public JWK from a local `.well-known/jwks.json`,
 * points `gateway.auth.clerk.jwksUrl` at it, and mints a valid Clerk-shaped JWT so
 * QA has a working Bearer token immediately. The verifier, scope derivation, 401
 * fail-closed, and 429 τ-throttle behave EXACTLY as in prod (mirrors the
 * src/gateway/tau-meter.e2e.test.ts harness, which is the regression lock).
 *
 * REAL-CLERK MODE: pass `--real-clerk` (or set OPENCLAW_QA_REAL_CLERK=1) to skip
 * the local JWKS and instead read devex's real config from the environment
 * (OPENCLAW_CLERK_JWKS_URL / _ISSUER / _AUDIENCE, sourced from Infisical). In that
 * mode the script does NOT mint a token — you supply a real Clerk session JWT from
 * the mobile app / SJ, and the curl examples use $CLERK_JWT.
 *
 * Usage:
 *   node --import tsx scripts/dev/chat-auth-qa-preview.ts [--port 18799]
 *        [--budget 5] [--window-ms 60000] [--sub user_qa_alice] [--real-clerk]
 *
 * Then follow the printed curl commands. Ctrl-C to stop.
 */
import { generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

// --- tiny arg parser --------------------------------------------------------

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const PORT = Number(getArg("--port") ?? 18799);
const BUDGET = Number(getArg("--budget") ?? 5); // max turns per window (cost 1/turn)
const WINDOW_MS = Number(getArg("--window-ms") ?? 60_000);
const SUB = getArg("--sub") ?? "user_qa_alice";
const REAL_CLERK = hasFlag("--real-clerk") || process.env.OPENCLAW_QA_REAL_CLERK === "1";
const GATEWAY_TOKEN = "qa-legacy-token"; // legacy shared-token, for the unscoped path demo

// --- Clerk JWT minting (local dev mode; mirrors auth-clerk.test.ts) ----------

const KID = "qa-preview-kid";
const ISSUER = "https://qa-preview.clerk.local";
const AUDIENCE = "openclaw-qa-preview";

type JwkWithMeta = JsonWebKey & { kid?: string; alg?: string; use?: string };

function makeKeypair(kid: string): { privateKey: KeyObject; jwk: JwkWithMeta } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JwkWithMeta;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function mintToken(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = b64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64url(payload);
  const signingInput = `${header}.${body}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}
function clerkBearer(sub: string, privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  return mintToken({ sub, iss: ISSUER, aud: AUDIENCE, exp: now + 3600, nbf: now - 60 }, privateKey);
}

// --- main -------------------------------------------------------------------

async function main() {
  let clerk: { jwksUrl: string; issuer: string; audience: string };
  let jwksServer: Server | undefined;
  let qaToken: string | undefined;

  if (REAL_CLERK) {
    const jwksUrl = process.env.OPENCLAW_CLERK_JWKS_URL?.trim();
    const issuer = process.env.OPENCLAW_CLERK_ISSUER?.trim();
    const audience = process.env.OPENCLAW_CLERK_AUDIENCE?.trim();
    if (!jwksUrl || !issuer || !audience) {
      console.error(
        "[--real-clerk] requires OPENCLAW_CLERK_JWKS_URL / _ISSUER / _AUDIENCE in the env\n" +
          "(source them from Infisical / devex). You supply the real Clerk JWT yourself.",
      );
      process.exit(1);
    }
    clerk = { jwksUrl, issuer, audience };
  } else {
    const kp = makeKeypair(KID);
    jwksServer = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [kp.jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer!.listen(0, "127.0.0.1", resolve));
    const addr = jwksServer.address() as AddressInfo;
    clerk = {
      jwksUrl: `http://127.0.0.1:${addr.port}/.well-known/jwks.json`,
      issuer: ISSUER,
      audience: AUDIENCE,
    };
    qaToken = clerkBearer(SUB, kp.privateKey);
  }

  const { startGatewayServer } = await import("../../src/gateway/server.js");
  const server = await startGatewayServer(PORT, {
    host: "127.0.0.1",
    controlUiEnabled: false,
    openResponsesEnabled: true,
    openAiChatCompletionsEnabled: true,
    auth: {
      mode: "token",
      token: GATEWAY_TOKEN,
      clerk,
      tau: { enabled: true, maxCostPerWindow: BUDGET, windowMs: WINDOW_MS },
    },
  });

  const base = `http://127.0.0.1:${PORT}`;
  const bear = qaToken ?? "$CLERK_JWT";

  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "==========================================================================",
      "  openclaw chat-auth P1 — QA PREVIEW GATEWAY (LIVE)",
      "==========================================================================",
      `  Base URL          : ${base}`,
      `  Canonical chat    : POST ${base}/v1/responses   (SSE, OpenResponses)`,
      `  Compat chat       : POST ${base}/v1/chat/completions`,
      `  Auth mode         : Clerk JWT (RS256/JWKS) — fail-closed 401 on invalid/missing`,
      `  Clerk issuer      : ${clerk.issuer}`,
      `  Clerk audience    : ${clerk.audience}`,
      `  Clerk JWKS        : ${clerk.jwksUrl}`,
      `  τ budget          : ${BUDGET} turn(s) / ${WINDOW_MS}ms per user_scope → 429 + Retry-After`,
      `  user_scope        : derived server-side from the verified Clerk sub (never client-sent)`,
      REAL_CLERK
        ? `  Token             : REAL-CLERK mode — export CLERK_JWT=<a real Clerk session JWT> first`
        : `  Demo sub          : ${SUB}  (user_scope = "${SUB}")`,
      "==========================================================================",
      "",
      ...(qaToken
        ? [
            "# A ready-to-use Clerk JWT for QA (valid 1h, sub=" + SUB + "):",
            `export CLERK_JWT='${qaToken}'`,
            "",
          ]
        : []),
      "# 1) HAPPY PATH — Clerk-JWT'd streamed POST /v1/responses (SSE):",
      `curl -N -sS ${base}/v1/responses \\`,
      `  -H "Authorization: Bearer ${bear}" \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"model":"openclaw","input":"hello from QA","stream":true}'`,
      "#   → text/event-stream; named events: response.created, response.output_text.delta,",
      "#     response.completed (with usage). Each request DEBITS 1 from the user_scope budget.",
      "",
      "# 2) NON-STREAMING fallback (single JSON response):",
      `curl -sS ${base}/v1/responses \\`,
      `  -H "Authorization: Bearer ${bear}" \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"model":"openclaw","input":"hello","stream":false}'`,
      "",
      "# 3) AUTH FAIL-CLOSED — no token → 401 (chat REQUIRES a valid Clerk JWT):",
      `curl -sS -o /dev/null -w 'no-token   → HTTP %{http_code}\\n' ${base}/v1/responses \\`,
      `  -H 'Content-Type: application/json' -d '{"model":"openclaw","input":"hi"}'`,
      `curl -sS -o /dev/null -w 'bad-token  → HTTP %{http_code}\\n' ${base}/v1/responses \\`,
      `  -H 'Authorization: Bearer not.a.jwt' \\`,
      `  -H 'Content-Type: application/json' -d '{"model":"openclaw","input":"hi"}'`,
      "#   → both 401. (A malformed/expired/wrong-aud/wrong-iss/alg-confused JWT all 401.)",
      "",
      "# 4) SCOPE KEYING — the same sub on any surface shares ONE budget. Verify the τ 429:",
      `#   Fire ${BUDGET + 1} authed turns fast; turn #${BUDGET + 1} → 429 + Retry-After:`,
      `for i in $(seq 1 ${BUDGET + 1}); do \\`,
      `  curl -sS -o /dev/null -w "turn $i → HTTP %{http_code} (Retry-After=%{header_json})\\n" \\`,
      `    ${base}/v1/responses -H "Authorization: Bearer ${bear}" \\`,
      `    -H 'Content-Type: application/json' \\`,
      `    -d '{"model":"openclaw","input":"hi","stream":false}'; done`,
      "#   → the first " + BUDGET + " return 200, the next returns 429 with a Retry-After header.",
      "#   /v1/chat/completions shares the SAME user_scope budget (swap the path to confirm).",
      "",
      "# 5) UNSCOPED never metered — legacy shared-token caller is NOT throttled by τ:",
      `#   (the auth layer fails closed; the meter fails OPEN on a missing user_scope)`,
      `curl -sS -o /dev/null -w 'legacy-token → HTTP %{http_code}\\n' ${base}/v1/responses \\`,
      `  -H 'Authorization: Bearer ${GATEWAY_TOKEN}' \\`,
      `  -H 'Content-Type: application/json' -d '{"model":"openclaw","input":"hi","stream":false}'`,
      "",
      "Ctrl-C to stop the gateway.",
      "",
    ].join("\n"),
  );

  const shutdown = async () => {
    await server.close({ reason: "qa-preview shutdown" }).catch(() => {});
    await new Promise<void>((resolve) =>
      jwksServer ? jwksServer.close(() => resolve()) : resolve(),
    );
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
