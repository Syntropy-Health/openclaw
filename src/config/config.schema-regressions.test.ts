import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts gateway.channelHealthCheckMinutes (strict-schema gap regression)", () => {
    // The field exists on GatewayConfig (types.gateway.ts) and is honored at
    // runtime, but was missing from the .strict() gateway zod object — so any
    // config that set it failed strict validation. Pin that it validates.
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 10,
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts gateway.channelHealthCheckMinutes = 0 (disable sentinel)", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 0,
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects negative gateway.channelHealthCheckMinutes", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: -1,
      },
    });

    expect(res.ok).toBe(false);
  });
});
