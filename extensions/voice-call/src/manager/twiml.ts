import { escapeXml } from "../voice-mapping.js";

export function generateNotifyTwiml(message: string, voice: string): string {
  // ASYMMETRY IS DELIBERATE, DO NOT REPLICATE BLINDLY (#217): of the two
  // interpolations on the <Say> line, only `message` is escaped here.
  // `voice` is an ATTRIBUTE token whose safety is discharged UPSTREAM by
  // mapVoiceToPolly's grammar validation (voice-mapping.ts) — every live
  // caller routes through it. escapeXml on the attribute would mask an
  // invalid token instead of rejecting it. If you add a caller, it MUST
  // pass the voice through mapVoiceToPolly (or equivalent validation);
  // passing a raw string here reopens attribute injection.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}
