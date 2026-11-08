import { describe, expect, it } from "vitest";
import { generateNotifyTwiml } from "./twiml.js";

describe("generateNotifyTwiml — TwiML artifact (pure)", () => {
  it("XML-escapes the spoken text — a payload cannot inject TwiML elements", () => {
    const hostile = 'Tom & Jerry <Hangup/> "quoted"';
    const twiml = generateNotifyTwiml(hostile, "alice");
    // Every dangerous character is an entity, and none survives raw inside <Say>.
    expect(twiml).toContain("Tom &amp; Jerry &lt;Hangup/&gt; &quot;quoted&quot;");
    expect(twiml).not.toContain("Tom & Jerry");
    // Exactly ONE real <Hangup/> element — the injected one did not materialize.
    expect(twiml.split("<Hangup/>")).toHaveLength(2);
  });

  it("renders the requested TTS voice into the Say attribute", () => {
    expect(generateNotifyTwiml("hello", "Polly.Joanna")).toContain('voice="Polly.Joanna"');
    expect(generateNotifyTwiml("hello", "alice")).toContain('voice="alice"');
  });

  // The `voice` argument is interpolated RAW into the Say attribute (only the
  // message is escaped): callers must validate it, which every live caller does
  // through mapVoiceToPolly (see twiml.ts). This pins the sharp edge: if the
  // function ever starts escaping the attribute, this goes red and the caller
  // obligation in twiml.ts can be revisited.
  it("does NOT escape the voice attribute — callers must validate it (documented sharp edge)", () => {
    const hostile = '"><Say>pwned</Say><Say voice="x';
    expect(generateNotifyTwiml("hello", hostile)).toContain(`voice="${hostile}"`);
  });
});
