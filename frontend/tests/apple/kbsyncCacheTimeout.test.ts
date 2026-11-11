import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDownloadKBSync: vi.fn(),
}));

vi.mock("../../src/apple/sap/kbsyncCache", () => ({
  KBSYNC_CACHE_TIMEOUT_MS: 5_000,
  loadDownloadKBSync: mocks.loadDownloadKBSync,
  acceptDownloadKBSync: vi.fn(),
  forgetDownloadKBSync: vi.fn(),
  invalidateDownloadKBSync: vi.fn(),
  clearDownloadKBSyncCache: vi.fn(),
}));

vi.mock("../../src/apple/sap/protocol", () => ({
  fetchSetupCertificate: vi.fn(),
  exchangeSetupBuffer: vi.fn(),
}));

vi.mock("../../src/apple/sap/assets", () => ({
  loadSapAssets: vi.fn(),
}));

import { loadSapAssets } from "../../src/apple/sap/assets";
import {
  generateDownloadKBSync,
  KBSYNC_CACHE_TIMEOUT_MS,
} from "../../src/apple/sap/client";

class StubWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;

  postMessage(message: { id: number; type: string }): void {
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          type: "result",
          id: message.id,
        },
      });
    });
  }

  terminate(): void {}
}

describe("generateDownloadKBSync cache read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", StubWorker);
    mocks.loadDownloadKBSync.mockReturnValue(new Promise(() => {}));
    vi.mocked(loadSapAssets).mockRejectedValue(
      new Error("generation attempted"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("falls back to generation after a blocked IndexedDB read", async () => {
    const assertion = expect(
      generateDownloadKBSync("aabbccddeeff", "1234567890"),
    ).rejects.toThrow("generation attempted");

    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);

    await assertion;
    expect(loadSapAssets).toHaveBeenCalledTimes(1);
  });

  it("asks storage again after a timed-out cache read", async () => {
    const first = expect(
      generateDownloadKBSync("aabbccddeeff", "1234567890"),
    ).rejects.toThrow("generation attempted");
    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);
    await first;
    expect(mocks.loadDownloadKBSync).toHaveBeenCalledTimes(1);

    const second = expect(
      generateDownloadKBSync("aabbccddeeff", "1234567890"),
    ).rejects.toThrow("generation attempted");
    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);
    await second;

    expect(mocks.loadDownloadKBSync).toHaveBeenCalledTimes(2);
  });
});
