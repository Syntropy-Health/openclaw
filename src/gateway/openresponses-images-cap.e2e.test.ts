import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ImageInputUnsupportedError } from "../agents/pi-embedded-runner/run/images.js";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const MIB = 1024 * 1024;
let server: { close: (opts: { reason: string }) => Promise<void> };
let port: number;

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

beforeAll(async () => {
  await writeGatewayConfig({
    gateway: {
      http: {
        endpoints: {
          responses: { enabled: true, images: { maxBytes: 2 * MIB, maxCount: 1 } },
        },
      },
    },
  });
  port = await getFreePort();
  const { startGatewayServer } = await import("./server.js");
  server = await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openResponsesEnabled: true,
  });
});

afterAll(async () => {
  await server.close({ reason: "openresponses image cap suite done" });
});

beforeEach(() => {
  agentCommand.mockReset();
  agentCommand.mockResolvedValue({ payloads: [{ text: "ok" }] } as never);
});

function imagePart(bytes: number) {
  return {
    type: "input_image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: Buffer.alloc(bytes, 7).toString("base64"),
    },
  };
}

async function postImages(parts: unknown[]) {
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "what did I eat?" }, ...parts],
        },
      ],
    }),
  });
}

describe("OpenResponses input_image limits (e2e)", () => {
  it("rejects more images than images.maxCount with a 400 naming the cap", async () => {
    const res = await postImages([imagePart(1024), imagePart(1024)]);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
    expect(json.error?.message).toMatch(/Too many input images: 2 \(limit: 1/);
    expect(json.error?.message).toContain("images.maxCount");
    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("rejects an image over images.maxBytes with a 400", async () => {
    const res = await postImages([imagePart(3 * MIB)]);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("accepts one small image and passes it to the agent", async () => {
    const res = await postImages([imagePart(1024)]);
    expect(res.status).toBe(200);
    await res.text();
    expect(agentCommand).toHaveBeenCalledTimes(1);
    const [opts] = agentCommand.mock.calls[0] ?? [];
    expect((opts as { images?: unknown[] } | undefined)?.images).toHaveLength(1);
  });
});

describe("OpenResponses: no image-capable model (e2e)", () => {
  it("non-stream: ImageInputUnsupportedError maps to a 400 invalid_request_error", async () => {
    agentCommand.mockReset();
    agentCommand.mockRejectedValueOnce(new ImageInputUnsupportedError(1));
    const res = await postImages([imagePart(1024)]);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
    expect(json.error?.message).toMatch(/does not accept image input/);
  });

  it("stream: ImageInputUnsupportedError ends with response.failed invalid_request_error", async () => {
    agentCommand.mockReset();
    agentCommand.mockRejectedValueOnce(new ImageInputUnsupportedError(1));
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({
        model: "openclaw",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "what did I eat?" }, imagePart(1024)],
          },
        ],
      }),
    });
    const text = await res.text();
    expect(text).toContain("response.failed");
    expect(text).toContain('"code":"invalid_request_error"');
    expect(text).toMatch(/does not accept image input/);
  });
});
