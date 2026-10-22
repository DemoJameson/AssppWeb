import { describe, expect, it, vi } from "vitest";
import { generateDownloadKBSync } from "../../src/apple/sap/client";

vi.mock("../../src/apple/sap/protocol", () => ({
  fetchSetupCertificate: vi.fn(),
  exchangeSetupBuffer: vi.fn(),
}));

const ASSETS = {
  commerceKit: new Uint8Array([1]),
  commerceCore: new Uint8Array([1]),
  coreFP: new Uint8Array([1]),
  coreFPICXS: new Uint8Array([1]),
  storeAgent: new Uint8Array([1]),
};

vi.mock("../../src/apple/sap/assets", () => ({
  loadSapAssets: vi.fn(async () => ASSETS),
}));

class StubWorker {
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() =>
      this.onmessage?.({
        data: {
          type: "result",
          id: message.id,
          ...(message.type === "kbsync"
            ? { kbsync: new Uint8Array([8, 7]).buffer }
            : {}),
        },
      }),
    );
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("download stage observer", () => {
  it("reports preparation while kbsync is generated", async () => {
    vi.resetModules();
    vi.stubGlobal("Worker", StubWorker);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const stages: Array<string | null> = [];
    await generateDownloadKBSync("aabbccddeeff", "1234567890", (stage) =>
      stages.push(stage),
    );

    expect(stages).toEqual(["preparing", null]);
    vi.unstubAllGlobals();
  });

  it("stays silent when an Apple-accepted blob is cached", async () => {
    vi.resetModules();
    vi.stubGlobal("Worker", StubWorker);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const client = await import("../../src/apple/sap/client");
    const first = await client.generateDownloadKBSync(
      "aabbccddeeff",
      "1234567890",
    );
    client.acceptDownloadKBSync("aabbccddeeff", "1234567890", first.blob);

    const stages: Array<string | null> = [];
    await client.generateDownloadKBSync("aabbccddeeff", "1234567890", (stage) =>
      stages.push(stage),
    );

    expect(stages).toEqual([]);
    vi.unstubAllGlobals();
  });
});
