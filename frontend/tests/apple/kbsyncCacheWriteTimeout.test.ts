import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("idb", () => ({
  openDB: vi.fn(() => new Promise<never>(() => {})),
}));

import {
  acceptDownloadKBSync,
  clearDownloadKBSyncCache,
  forgetDownloadKBSync,
  invalidateDownloadKBSync,
  KBSYNC_CACHE_TIMEOUT_MS,
  loadDownloadKBSync,
} from "../../src/apple/sap/kbsyncCache";

describe("kbsync cache IndexedDB timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("treats a blocked read as a cache miss", async () => {
    const read = loadDownloadKBSync("aabbccddeeff", "1234567890");
    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);

    await expect(read).resolves.toBeNull();
  });

  it("bounds blocked writes, invalidations and deletions", async () => {
    const accept = acceptDownloadKBSync(
      "aabbccddeeff",
      "1234567890",
      "blob",
    );
    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);
    await expect(accept).resolves.toBeUndefined();

    const invalidate = invalidateDownloadKBSync(
      "aabbccddeeff",
      "1234567890",
      "blob",
    );
    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);
    await expect(invalidate).resolves.toBeUndefined();

    const forget = forgetDownloadKBSync("aabbccddeeff", "1234567890");
    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);
    await expect(forget).resolves.toBeUndefined();

    const clear = clearDownloadKBSyncCache();
    await vi.advanceTimersByTimeAsync(KBSYNC_CACHE_TIMEOUT_MS);
    await expect(clear).resolves.toBeUndefined();
  });
});
