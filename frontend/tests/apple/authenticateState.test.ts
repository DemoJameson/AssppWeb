import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";

const mocks = vi.hoisted(() => ({
  fetchAuthHeaders: vi.fn(),
  runAnisetteTask: vi.fn(),
  getAnisetteState: vi.fn(),
  setAnisetteState: vi.fn(),
}));

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/apple/bag")>()),
  fetchBag: vi.fn(),
}));

vi.mock("../../src/apple/anisette", () => ({
  fetchAuthHeaders: mocks.fetchAuthHeaders,
  handleAuthAction: vi.fn(),
  runAnisetteTask: mocks.runAnisetteTask,
}));

vi.mock("../../src/apple/anisetteStore", () => ({
  getAnisetteState: mocks.getAnisetteState,
  setAnisetteState: mocks.setAnisetteState,
  clearAnisetteState: vi.fn(),
}));

describe("apple/authenticate Anisette state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: { appleId: "test@example.com", address: {} },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });
    mocks.getAnisetteState.mockResolvedValue(undefined);
    mocks.setAnisetteState.mockResolvedValue(undefined);
    mocks.fetchAuthHeaders.mockResolvedValue({
      state: "next-state",
      headers: {},
    });
  });

  it("reads state after waiting in the Anisette queue", async () => {
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;

    mocks.runAnisetteTask.mockImplementation(
      async (_deviceIdentifier: string, task: () => Promise<unknown>) => {
        if (first) {
          first = false;
          entered();
          await barrier;
        }
        return task();
      },
    );
    mocks.getAnisetteState.mockResolvedValue("stale-state");

    const promise = authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    await queued;
    mocks.getAnisetteState.mockResolvedValue("fresh-state");
    release();
    await promise;

    expect(mocks.fetchAuthHeaders).toHaveBeenCalledWith(
      "aabbccddeeff",
      "fresh-state",
      expect.stringContaining("guid="),
    );
  });
});
