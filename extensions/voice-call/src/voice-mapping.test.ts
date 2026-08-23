/**
 * #217 — mapVoiceToPolly's validated pass-through, RED-ARM proven.
 *
 * History this pins: the pass-through branch returned ANY `Polly.`/`Google.`-
 * prefixed string verbatim, and the result lands RAW inside `<Say voice="…">`
 * at both live call sites (manager/outbound.ts and providers/twilio.ts). The
 * "config-derived therefore bounded" reasoning was true of the OpenAI branch
 * and FALSE of this one. The prior guard for this edge (XML_UNSAFE) is
 * stranded on the retired syntropy-mcp voice adapter — a path nobody calls —
 * and, per the #216 record, it was "the only guard on this edge AND the only
 * test of it", which is why deleting one caller removed both. This suite is
 * the replacement: it tests the CHOKE POINT both live callers share, so no
 * single caller's retirement can strand it again.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLLY_VOICE, mapVoiceToPolly } from "./voice-mapping.js";

describe("#217 — provider-voice pass-through is VALIDATED, not verbatim", () => {
  it.each(["Polly.Joanna", "Polly.Matthew", "Google.en-US-Neural2-A", "Polly.Kajal-Neural"])(
    "valid provider token %s passes through unchanged",
    (voice) => {
      expect(mapVoiceToPolly(voice)).toBe(voice);
    },
  );

  it("RED ARM: an XML-active string behind the prefix does NOT pass through", () => {
    // The exact injection shape from the #216/#217 record: prefix satisfied,
    // payload breaks out of the voice attribute. Before the fix this returned
    // verbatim; this assertion goes red if the grammar check is removed.
    const hostile = 'Polly."><Say>pwned</Say><Say voice="x';
    const out = mapVoiceToPolly(hostile);
    expect(out).toBe(DEFAULT_POLLY_VOICE);
    expect(out).not.toContain('"');
    expect(out).not.toContain("<");
  });

  it.each([
    ['Polly."><Hangup/>', "attribute breakout"],
    ["Polly.Jo anna", "whitespace"],
    ["Polly.", "empty token"],
    ["Google.<script>", "angle brackets"],
    [`Polly.${"a".repeat(100)}`, "over-length token"],
    ["Polly.Jo'anna", "apostrophe"],
  ])("malformed provider token %s (%s) fails CLOSED to the default voice", (voice) => {
    expect(mapVoiceToPolly(voice)).toBe(DEFAULT_POLLY_VOICE);
  });

  it("rejection logs the shape SAFELY — JSON-escaped, capped, single line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mapVoiceToPolly('Polly."\nFORGED-LINE');
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      // The raw newline must arrive escaped inside one line, never as a break.
      expect(line).not.toContain("\n");
      expect(line).toContain("\\n");
    } finally {
      warn.mockRestore();
    }
  });

  it("valid tokens do not log (the warning must stay meaningful)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mapVoiceToPolly("Polly.Joanna");
      mapVoiceToPolly("alloy");
      mapVoiceToPolly(undefined);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("existing contract unchanged: OpenAI names map, unknowns and absent default", () => {
    expect(mapVoiceToPolly("alloy")).toBe("Polly.Joanna");
    expect(mapVoiceToPolly("ECHO")).toBe("Polly.Matthew");
    expect(mapVoiceToPolly("not-a-voice")).toBe(DEFAULT_POLLY_VOICE);
    expect(mapVoiceToPolly(undefined)).toBe(DEFAULT_POLLY_VOICE);
  });
});
