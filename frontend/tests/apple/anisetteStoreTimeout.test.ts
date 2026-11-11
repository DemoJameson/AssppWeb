import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDB: vi.fn(),
}));

vi.mock("idb", () => ({
  openDB: mocks.openDB,
}));

import {
  ANISETTE_STATE_TIMEOUT_MS,
  getAnisetteState,
  setAnisetteState,
} from "../../src/apple/anisetteStore";

describe("apple/anisetteStore timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.openDB.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("falls back when IndexedDB never opens", async () => {
    const read = getAnisetteState("aabbccddeeff");
    await vi.advanceTimersByTimeAsync(ANISETTE_STATE_TIMEOUT_MS);

    await expect(read).resolves.toBeUndefined();
  });

  it("does not leave a state write pending forever", async () => {
    const write = setAnisetteState("aabbccddeeff", "state");
    await vi.advanceTimersByTimeAsync(ANISETTE_STATE_TIMEOUT_MS);

    await expect(write).resolves.toBeUndefined();
  });

  it("keeps a state whose write timed out for the SP action", async () => {
    const device = "aabbccddeeaa";
    const write = setAnisetteState(device, "state-in-memory");
    await vi.advanceTimersByTimeAsync(ANISETTE_STATE_TIMEOUT_MS);

    await expect(write).resolves.toBeUndefined();
    // The fallback is read without touching the blocked IndexedDB again.
    await expect(getAnisetteState(device)).resolves.toBe("state-in-memory");
    expect(mocks.openDB).toHaveBeenCalledTimes(1);
  });

  it("retries a rejected IndexedDB open on the next call", async () => {
    mocks.openDB.mockReset();
    mocks.openDB.mockRejectedValueOnce(new Error("open failed"));
    mocks.openDB.mockResolvedValueOnce({
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(),
      delete: vi.fn(),
    });

    await expect(getAnisetteState("aabbccddeeab")).resolves.toBeUndefined();
    await expect(getAnisetteState("aabbccddeeab")).resolves.toBeUndefined();

    expect(mocks.openDB).toHaveBeenCalledTimes(2);
  });
});
