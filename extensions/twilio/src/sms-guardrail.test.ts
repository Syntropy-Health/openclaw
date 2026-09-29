import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import twilioSmsPlugin from "./index.js";
import { SMS_NO_MEDICAL_ADVICE_GUARDRAIL, smsGuardrailFor } from "./sms-guardrail.js";

describe("SMS no-medical-advice guardrail — the text", () => {
  it("forbids medical advice explicitly, and names the actions it covers", () => {
    const g = SMS_NO_MEDICAL_ADVICE_GUARDRAIL;
    expect(g).toContain("MUST NOT give medical advice");
    expect(g).toMatch(/not a doctor/i);
    expect(g).toMatch(/diagnose/);
    expect(g).toMatch(/dose/);
    expect(g).toMatch(/911/);
  });
});

describe("smsGuardrailFor — scoped to SMS turns only", () => {
  it("an SMS turn gets the guardrail as prependContext (the field the run consumes)", () => {
    expect(smsGuardrailFor({ messageProvider: "sms" })).toEqual({
      prependContext: SMS_NO_MEDICAL_ADVICE_GUARDRAIL,
    });
  });
  it("it never returns systemPrompt — that hook field is merged but not read by the run", () => {
    expect(smsGuardrailFor({ messageProvider: "sms" })).not.toHaveProperty("systemPrompt");
  });
  it("non-SMS turns (whatsapp, webchat, unknown, missing ctx) are untouched", () => {
    for (const p of ["whatsapp", "webchat", "SMS", "", undefined]) {
      expect(smsGuardrailFor({ messageProvider: p }), String(p)).toEqual({});
    }
    expect(smsGuardrailFor(undefined)).toEqual({});
  });
});

describe("the enabled plugin WIRES the guardrail", () => {
  function fakeApi(pluginConfig: Record<string, unknown>) {
    const on = vi.fn();
    const api = {
      id: "twilio",
      config: { channels: {} },
      pluginConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerChannel: vi.fn(),
      registerHttpRoute: vi.fn(),
      on,
    } as unknown as OpenClawPluginApi;
    return { api, on };
  }

  it("smsEnabled registers a before_agent_start hook that returns the guardrail for SMS", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { api, on } = fakeApi({ smsEnabled: true });
      await twilioSmsPlugin.register(api);
      const calls = on.mock.calls.filter((c) => c[0] === "before_agent_start");
      expect(calls).toHaveLength(1);
      const handler = calls[0][1] as (e: unknown, ctx: unknown) => Promise<unknown>;
      await expect(handler({}, { messageProvider: "sms" })).resolves.toEqual({
        prependContext: SMS_NO_MEDICAL_ADVICE_GUARDRAIL,
      });
      await expect(handler({}, { messageProvider: "whatsapp" })).resolves.toEqual({});
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it("the disabled plugin registers no guardrail hook (and no surface)", async () => {
    const { api, on } = fakeApi({});
    await twilioSmsPlugin.register(api);
    expect(on.mock.calls.filter((c) => c[0] === "before_agent_start")).toHaveLength(0);
  });
});
