import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

// A PDF whose pages are rendered to images: stub the renderer to return two page images,
// so the test does not depend on the native canvas module.
vi.mock("../media/input-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/input-files.js")>();
  return {
    ...actual,
    extractFileContentFromSource: vi.fn(async () => ({
      filename: "menu.pdf",
      text: "",
      images: [
        { type: "image", data: "cGFnZTE=", mimeType: "image/png" },
        { type: "image", data: "cGFnZTI=", mimeType: "image/png" },
      ],
    })),
  };
});

installGatewayTestHooks({ scope: "suite" });

let server: { close: (opts: { reason: string }) => Promise<void> };
let port: number;

beforeAll(async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: { http: { endpoints: { responses: { enabled: true, images: { maxCount: 1 } } } } },
    }),
  );
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
  await server.close({ reason: "openresponses pdf image cap suite done" });
});

describe("OpenResponses images.maxCount counts PDF-rendered pages (e2e)", () => {
  it("1 input_image + a 2-page rendered PDF with maxCount 1 gives a 400", async () => {
    agentCommand.mockReset();
    agentCommand.mockResolvedValue({ payloads: [{ text: "ok" }] } as never);
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "what is on this menu?" },
              {
                type: "input_image",
                source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" },
              },
              {
                type: "input_file",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0=",
                  filename: "menu.pdf",
                },
              },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
    expect(json.error?.message).toMatch(/Too many input images: 3 \(limit: 1/);
    expect(agentCommand).not.toHaveBeenCalled();
  });
});
