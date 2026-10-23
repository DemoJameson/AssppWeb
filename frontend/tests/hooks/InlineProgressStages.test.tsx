import { describe, expect, it, vi } from "vitest";
import { generateDownloadKBSync } from "../../src/apple/sap/client";
import type { DownloadExchangeProgress } from "../../src/apple/sap/client";

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
  it("reports preparation progress while kbsync is generated", async () => {
    vi.resetModules();
    vi.stubGlobal("Worker", StubWorker);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const progress: Array<DownloadExchangeProgress | null> = [];
    await generateDownloadKBSync("aabbccddeeff", "1234567890", (next) =>
      progress.push(next),
    );

    expect(progress).toEqual([
      { stage: "preparing", percent: 0 },
      { stage: "initializing", percent: null },
      null,
    ]);
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

    const progress: Array<DownloadExchangeProgress | null> = [];
    await client.generateDownloadKBSync("aabbccddeeff", "1234567890", (next) =>
      progress.push(next),
    );

    expect(progress).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("maps asset bytes to clamped integer progress and broadcasts it", async () => {
    vi.resetModules();
    vi.stubGlobal("Worker", StubWorker);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const assets = await import("../../src/apple/sap/assets");
    vi.mocked(assets.loadSapAssets).mockClear();
    let reportBytes!: (loaded: number, total: number) => void;
    let finishAssets!: () => void;
    const assetsReady = new Promise<void>((resolve) => {
      finishAssets = resolve;
    });
    vi.mocked(assets.loadSapAssets).mockImplementationOnce(
      async (onProgress) => {
        reportBytes = onProgress!;
        await assetsReady;
        return ASSETS;
      },
    );
    const client = await import("../../src/apple/sap/client");

    const first: Array<DownloadExchangeProgress | null> = [];
    const second: Array<DownloadExchangeProgress | null> = [];
    const firstRun = client.generateDownloadKBSync(
      "aabbccddeeff",
      "1234567890",
      (next) => first.push(next),
    );
    const secondRun = client.generateDownloadKBSync(
      "aabbccddeeff",
      "1234567890",
      (next) => second.push(next),
    );
    reportBytes(0, 100);
    reportBytes(42, 100);
    reportBytes(100, 100);
    finishAssets();
    await Promise.all([firstRun, secondRun]);

    const expected = [
      { stage: "preparing", percent: 0 },
      { stage: "preparing", percent: 42 },
      { stage: "preparing", percent: 99 },
      { stage: "initializing", percent: null },
      null,
    ];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(vi.mocked(assets.loadSapAssets)).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("leaves the percentage as soon as the assets finish loading", async () => {
    vi.resetModules();
    vi.stubGlobal("Worker", StubWorker);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const assets = await import("../../src/apple/sap/assets");
    vi.mocked(assets.loadSapAssets).mockImplementationOnce(async (onProgress) => {
      onProgress?.(100, 100);
      return ASSETS;
    });
    const client = await import("../../src/apple/sap/client");

    const progress: Array<DownloadExchangeProgress | null> = [];
    await client.generateDownloadKBSync("aabbccddeeff", "1234567890", (next) =>
      progress.push(next),
    );

    expect(progress).toEqual([
      { stage: "preparing", percent: 0 },
      { stage: "preparing", percent: 99 },
      { stage: "initializing", percent: null },
      null,
    ]);
    vi.unstubAllGlobals();
  });
});
