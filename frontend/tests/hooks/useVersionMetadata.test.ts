import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVersionMetadataMap } from "../../src/hooks/useVersionMetadata";
import {
  fetchVersionMetadata,
  saveVersionMetadata,
} from "../../src/api/versionMetadata";
import { getVersionMetadata } from "../../src/apple/versionLookup";
import { useVersionMetadataStore } from "../../src/store/versionMetadata";
import { useSettingsStore } from "../../src/store/settings";
import type { Account, Software } from "../../src/types";

const mocks = vi.hoisted(() => ({
  updateAccount: vi.fn(),
  accounts: [] as Account[],
}));

vi.mock("../../src/api/versionMetadata", () => ({
  fetchVersionMetadata: vi.fn(),
  saveVersionMetadata: vi.fn(),
}));

vi.mock("../../src/apple/versionLookup", () => ({
  getVersionMetadata: vi.fn(),
}));

vi.mock("../../src/store/accounts", () => ({
  useAccountsStore: {
    getState: () => ({
      accounts: mocks.accounts,
      updateAccount: mocks.updateAccount,
    }),
  },
}));

const account: Account = {
  email: "dev@example.test",
  password: "secret",
  appleId: "dev@example.test",
  store: "143441",
  firstName: "Dev",
  lastName: "Tester",
  passwordToken: "token",
  directoryServicesIdentifier: "123456789",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
};

const app: Software = {
  id: 6503940939,
  bundleID: "com.example.utility",
  name: "Example Utility",
  version: "1.0.0",
  price: 0,
  artistName: "Example",
  sellerName: "Example",
  description: "",
  averageUserRating: 4.5,
  userRatingCount: 10,
  artworkUrl: "",
  screenshotUrls: [],
  minimumOsVersion: "16.0",
  releaseDate: "2026-01-01T00:00:00Z",
  primaryGenreName: "Utilities",
};

describe("useVersionMetadataMap", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.accounts = [account];
    useVersionMetadataStore.setState({ entries: {} });
    useSettingsStore.setState({
      autoFetchVersionInfo: true,
      autoAcquireLicense: true,
    });
  });

  it("merges cached entries fetched by ensureLoaded", async () => {
    vi.mocked(fetchVersionMetadata).mockResolvedValue({
      "894041913": {
        displayVersion: "8.2.1",
        releaseDate: "2025-06-12T00:00:00.000Z",
      },
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    await act(() => result.current.ensureLoaded(6503940939));

    expect(result.current.versionMeta["894041913"].displayVersion).toBe("8.2.1");
  });

  it("keeps an existing entry when the cache brings a duplicate", async () => {
    vi.mocked(fetchVersionMetadata).mockResolvedValue({
      "1": { displayVersion: "9.9.9", releaseDate: "cached" },
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.recordMetadata(1, "1", {
        displayVersion: "1.0.0",
        releaseDate: "fetched",
      });
    });
    await act(() => result.current.ensureLoaded(1));

    expect(result.current.versionMeta["1"].displayVersion).toBe("1.0.0");
  });

  it("records live metadata and writes it back to the backend", () => {
    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.recordMetadata(6503940939, "2", {
        displayVersion: "1.0.0",
        releaseDate: "a",
      });
    });

    expect(result.current.versionMeta["2"].displayVersion).toBe("1.0.0");
    expect(saveVersionMetadata).toHaveBeenCalledWith(6503940939, "2", {
      displayVersion: "1.0.0",
      releaseDate: "a",
    });
  });

  it("prefetches only missing versions, capped at twenty", async () => {
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: "1.0.0", releaseDate: "d" },
      updatedCookies: [],
    });
    useVersionMetadataStore.setState({
      entries: { known: { displayVersion: "0.1.0", releaseDate: "x" } },
    });
    const versions = [
      "known",
      ...Array.from({ length: 25 }, (_, index) => `missing-${index}`),
    ];

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, versions);
    });

    await vi.waitFor(() => {
      expect(getVersionMetadata).toHaveBeenCalledTimes(20);
    });
    const asked = vi
      .mocked(getVersionMetadata)
      .mock.calls.map((call) => call[2]);
    expect(asked).not.toContain("known");
  });

  it("keeps at most five lookups in flight", async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(getVersionMetadata).mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        metadata: { displayVersion: "1.0.0", releaseDate: "d" },
        updatedCookies: [],
      };
    });

    const versions = Array.from({ length: 10 }, (_, index) => `v-${index}`);
    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, versions);
    });

    await vi.waitFor(() => {
      expect(getVersionMetadata).toHaveBeenCalledTimes(10);
    });
    await vi.waitFor(() => {
      expect(active).toBe(0);
    });
    expect(maxActive).toBe(5);
  });

  it("records prefetched metadata and refreshes the session", async () => {
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: "2.2.2", releaseDate: "2026-05-05" },
      updatedCookies: [],
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, ["101", "102"]);
    });

    await vi.waitFor(() => {
      expect(result.current.versionMeta["101"]?.displayVersion).toBe("2.2.2");
    });
    expect(saveVersionMetadata).toHaveBeenCalledWith(app.id, "102", {
      displayVersion: "2.2.2",
      releaseDate: "2026-05-05",
    });
    await vi.waitFor(() => {
      expect(mocks.updateAccount).toHaveBeenCalledTimes(2);
    });
    expect(mocks.updateAccount).toHaveBeenCalledWith({
      ...account,
      cookies: [],
    });
  });

  it("prefetches with the freshest stored copy of the account", async () => {
    const freshestAccount: Account = {
      ...account,
      deviceIdentifier: "freshest-device",
    };
    mocks.accounts = [freshestAccount];
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: "4.0.0", releaseDate: "2026-06-01" },
      updatedCookies: [],
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      // The caller hands in the pre-refresh snapshot; the hook must still run
      // the lookup on the account stored right now.
      result.current.prefetchMissing(account, app, ["201"]);
    });

    await vi.waitFor(() => {
      expect(getVersionMetadata).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(getVersionMetadata).mock.calls[0][0]).toEqual(
      freshestAccount,
    );
  });

  it("leaves state untouched when the cache has nothing", async () => {
    vi.mocked(fetchVersionMetadata).mockResolvedValue({});

    const { result } = renderHook(() => useVersionMetadataMap());
    await act(() => result.current.ensureLoaded(1));

    expect(result.current.versionMeta).toEqual({});
  });

  it("skips the prefetch when the automation switch is off", async () => {
    useSettingsStore.setState({ autoFetchVersionInfo: false });

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, ["1", "2"]);
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getVersionMetadata).not.toHaveBeenCalled();
  });
});
