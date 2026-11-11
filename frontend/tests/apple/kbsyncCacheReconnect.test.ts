import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDB: vi.fn(),
}));

vi.mock("idb", () => ({
  openDB: mocks.openDB,
}));

import { loadDownloadKBSync } from "../../src/apple/sap/kbsyncCache";

describe("kbsync cache connection recovery", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("opens a fresh database after a failed read", async () => {
    const closed = {
      get: vi.fn().mockRejectedValue(new Error("The database connection is closing")),
    };
    const healthy = {
      get: vi.fn().mockResolvedValue(undefined),
    };
    mocks.openDB.mockResolvedValueOnce(closed).mockResolvedValueOnce(healthy);

    await expect(loadDownloadKBSync("aabbccddeeff", "1234567890")).resolves.toBeNull();
    expect(closed.get).toHaveBeenCalledTimes(1);
    expect(mocks.openDB).toHaveBeenCalledTimes(1);

    // The failed connection must not become the promise every later read joins.
    await expect(loadDownloadKBSync("aabbccddeeff", "1234567890")).resolves.toBeNull();
    expect(healthy.get).toHaveBeenCalledTimes(1);
    expect(mocks.openDB).toHaveBeenCalledTimes(2);
  });
});
