# Kapso WhatsApp cutover checklist (slice 4 — Baileys → Kapso)

> The live-transport flip for the `whatsapp` channel (`channels.whatsapp.transport:
"kapso"`). Everything below must hold BEFORE the flip; item 4 is the gate.
> Provenance: B-Kapso slices 1–3b (#70/#71), transport primitive (#72), CTO
> dispatches #3943/#3978/#4041/#4056.

## Gate (all binding)

1. **[DONE — #72]** Transport selection rides the first-class plugin primitive
   `api.registerChannelTransport` + `registry.channelTransports` (lifecycle-
   invalidation on registry swap; no module singleton in the live path).
2. **[THIS DOC]** Behavior notes acknowledged (below).
3. **Dev-number E2E green** — run `scripts/e2e/kapso-dev-number.ts` (see header;
   Infisical `channels/kapso` creds at execution, `RUN_KAPSO_E2E=1` arm switch).
4. **The principal's explicit go.** The flip is a conscious, deliberate moment —
   never a default, never automated.

## Behavior notes (item 2 — acknowledged limitations at flip time)

- **TEXT-ONLY transport routing.** Only the outbound **text** send routes
  through the selected transport. `sendMedia` / `sendPoll` still use the Baileys
  path even under `transport: "kapso"` (pinned by
  `extensions/whatsapp/src/channel.send-options.test.ts` "sendMedia is NOT
  transport-routed"). Before or at cutover, either (a) route media/polls through
  Kapso (Cloud API media messages), or (b) explicitly accept text-only WhatsApp
  for the cutover period and fail media sends loudly. Do NOT flip assuming media
  parity exists.
- **`transport` is read from a config SNAPSHOT in places.** The kapso INBOUND
  gate reads the register-time config (`createKapsoOnInbound` — a `transport`
  flip requires a **gateway restart**); the OUTBOUND selector reads live per-send
  cfg. The cutover is a deploy/restart, so this is acceptable — but never flip by
  hot-editing config and assuming inbound follows.
- **Opt-out rail:** Kapso outbound is opt-out-guarded + fail-closed
  (`createKapsoOutboundTransport`); the shared SMS+WhatsApp keyspace is `+E164`.
  A dead opt-out store means NO proactive sends (by design). Verify
  `DATABASE_URL` is live in the deploy before the flip.
- **Fail-closed selection:** `transport: "kapso"` with the kapso extension
  disabled/unregistered **throws** (`WhatsAppTransportUnavailableError`) rather
  than silently sending via unguarded Baileys. If sends error post-flip, check
  the extension loaded — do not "fix" by removing the guard.
- **Dual-live prevention:** while `transport: "kapso"`, ensure NO Baileys
  session stays connected for the same number (the M3 inbound gate defends the
  kapso side only; a live Baileys socket would still process inbound
  independently). Disconnect/park Baileys as part of the flip runbook.

## Flip runbook (when item 4 lands)

1. Confirm gate items 1–3 green; principal go recorded (dispatch id).
2. Park the Baileys session for the dev/prod number.
3. Deploy with `channels.whatsapp.transport: "kapso"` (+ restart — snapshot note).
4. Re-run the E2E (inbound STOP/START/HELP + outbound nudge) against the flipped
   deploy.
5. Watch the opt-out rail + send logs; rollback = revert the config + restart
   (Baileys path is untouched and resumes as default).
