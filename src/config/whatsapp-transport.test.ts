import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

/**
 * B-Kapso slice 3b — the WhatsApp OUTBOUND `transport` selector.
 * Default MUST stay `baileys` (zero behavior change until the principal-gated
 * cutover); `kapso` is the new value; the superseded `twilio-waba` was dropped.
 */
describe("WhatsAppConfigSchema.transport (B-Kapso slice 3b)", () => {
  it("defaults to 'baileys' when omitted (no behavior change)", () => {
    const parsed = WhatsAppConfigSchema.parse({});
    expect(parsed.transport).toBe("baileys");
  });

  it("accepts 'kapso'", () => {
    expect(WhatsAppConfigSchema.parse({ transport: "kapso" }).transport).toBe("kapso");
  });

  it("accepts 'baileys' explicitly", () => {
    expect(WhatsAppConfigSchema.parse({ transport: "baileys" }).transport).toBe("baileys");
  });

  it("REJECTS the dropped 'twilio-waba' value (ADR 0002 — superseded)", () => {
    expect(WhatsAppConfigSchema.safeParse({ transport: "twilio-waba" }).success).toBe(false);
  });

  it("rejects an unknown transport", () => {
    expect(WhatsAppConfigSchema.safeParse({ transport: "carrier-pigeon" }).success).toBe(false);
  });
});
