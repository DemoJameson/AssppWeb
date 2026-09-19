import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVersionMetadataMap } from "../../src/hooks/useVersionMetadata";
import {
  fetchPackageVersionMetadata,
  fetchVersionMetadata,
  saveVersionMetadata,
} from "../../src/api/versionMetadata";
import { getDownloadInfo } from "../../src/apple/download";
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
  fetchPackageVersionMetadata: vi.fn(),
}));

vi.mock("../../src/apple/versionLookup", () => ({
  getVersionMetadata: vi.fn(),
}));

// The hook's accurate-date path goes through the pinned download exchange, and
// its transport must stay out of the jsdom graph (libcurl aborts on import).
vi.mock("../../src/apple/download", () => ({
  DownloadError: class DownloadError extends Error {},
  getDownloadInfo: vi.fn(),
}));
vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));
vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
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
    useVersionMetadataStore.setState({ entries: {}, pending: {} });
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

  it("prefetches only missing versions, capped at one hundred", async () => {
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: "1.0.0", releaseDate: "d" },
      updatedCookies: [],
    });
    useVersionMetadataStore.setState({
      entries: { known: { displayVersion: "0.1.0", releaseDate: "x" } },
    });
    const versions = [
      "known",
      ...Array.from({ length: 125 }, (_, index) => `missing-${index}`),
    ];

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, versions);
    });

    await vi.waitFor(
      () => {
        expect(getVersionMetadata).toHaveBeenCalledTimes(100);
      },
      { timeout: 5000 },
    );
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

  it("keeps the tail past the first twenty serial", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const starts: Array<{ index: number; active: number }> = [];
    vi.mocked(getVersionMetadata).mockImplementation(async () => {
      started += 1;
      active += 1;
      starts.push({ index: started, active });
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return {
        metadata: { displayVersion: "1.0.0", releaseDate: "d" },
        updatedCookies: [],
      };
    });

    const versions = Array.from({ length: 26 }, (_, index) => `v-${index}`);
    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, versions);
    });

    await vi.waitFor(() => {
      expect(getVersionMetadata).toHaveBeenCalledTimes(26);
    });
    await vi.waitFor(() => {
      expect(active).toBe(0);
    });

    expect(maxActive).toBe(5);
    const tail = starts.filter((sample) => sample.index > 20);
    expect(tail).toHaveLength(6);
    for (const sample of tail) {
      expect(sample.active).toBe(1);
    }
  });

  it("interrupts the queue when the page goes away, keeping finished writes", async () => {
    vi.mocked(getDownloadInfo).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        output: {
          downloadURL: "https://iosapps.example.com/app.ipa",
          sinfs: [],
          bundleShortVersionString: "1.0.0",
          bundleVersion: "100",
          bundleID: "com.example.utility",
        },
        updatedCookies: [],
      };
    });
    vi.mocked(fetchPackageVersionMetadata).mockResolvedValue({
      displayVersion: "1.0.0",
      releaseDate: "2026-01-01T00:00:00Z",
      source: "package",
    });

    const versions = Array.from({ length: 100 }, (_, index) => `v-${index}`);
    const { result, unmount } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, versions);
    });

    await vi.waitFor(() => {
      expect(getDownloadInfo).toHaveBeenCalledTimes(5);
    });
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 450));
    // Nothing new was queued after leaving…
    expect(getDownloadInfo).toHaveBeenCalledTimes(5);
    // …and the five already in flight still delivered their package reads —
    // the POST route is what writes those into the shared cache.
    expect(fetchPackageVersionMetadata).toHaveBeenCalledTimes(5);
  });

  it("does not start a fill that only begins after the page is gone", async () => {
    // The silent policy waits for the shared cache before filling: leaving in
    // the meantime must not queue lookups for a page nobody is on.
    let releaseCache: (() => void) | undefined;
    vi.mocked(fetchVersionMetadata).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCache = () => resolve({});
        }),
    );

    const { result, unmount } = renderHook(() => useVersionMetadataMap());
    act(() => {
      void result.current.fillVersionsSilently(account, app, ["800", "801"]);
    });

    unmount();
    releaseCache?.();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getVersionMetadata).not.toHaveBeenCalled();
  });

  it("ignores a prefetch asked for after the page is gone", async () => {
    const { result, unmount } = renderHook(() => useVersionMetadataMap());
    unmount();

    await act(async () => {
      await result.current.prefetchMissing(account, app, ["700"]);
    });

    expect(getVersionMetadata).not.toHaveBeenCalled();
  });

  it("marks versions as pending while their lookup runs", async () => {
    let releaseFetch: (() => void) | undefined;
    vi.mocked(getVersionMetadata).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFetch = () =>
            resolve({
              metadata: { displayVersion: "1.0.0", releaseDate: "d" },
              updatedCookies: [],
            });
        }),
    );

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, ["900"]);
    });

    await vi.waitFor(() => {
      expect(useVersionMetadataStore.getState().pending["900"]).toBe(true);
    });

    releaseFetch?.();
    await vi.waitFor(() => {
      expect(useVersionMetadataStore.getState().pending["900"]).toBeUndefined();
    });
  });

  it("records prefetched metadata and refreshes the session", async () => {
    vi.mocked(getDownloadInfo).mockResolvedValue({
      output: {
        downloadURL: "https://iosapps.example.com/app.ipa",
        sinfs: [],
        bundleShortVersionString: "2.2.2",
        bundleVersion: "222",
        bundleID: "com.example.utility",
      },
      updatedCookies: [],
    });
    vi.mocked(fetchPackageVersionMetadata).mockResolvedValue({
      displayVersion: "2.2.2",
      releaseDate: "2026-05-05T00:00:00Z",
      source: "package",
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    act(() => {
      result.current.prefetchMissing(account, app, ["101", "102"]);
    });

    await vi.waitFor(() => {
      expect(result.current.versionMeta["101"]?.displayVersion).toBe("2.2.2");
    });
    // The backend reads the date out of the package the pinned exchange named.
    expect(fetchPackageVersionMetadata).toHaveBeenCalledWith(
      app.id,
      "102",
      "https://iosapps.example.com/app.ipa",
    );
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

  it("runs the same fill on demand when the switch is off and force is passed", async () => {
    useSettingsStore.setState({ autoFetchVersionInfo: false });
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: "1.0.0", releaseDate: "d" },
      updatedCookies: [],
    });

    const { result } = renderHook(() => useVersionMetadataMap());
    let run!: Promise<void>;
    act(() => {
      run = result.current.prefetchMissing(account, app, ["1", "2"], {
        force: true,
      });
    });

    await vi.waitFor(() => {
      expect(getVersionMetadata).toHaveBeenCalledTimes(2);
    });
    await expect(run).resolves.toBeUndefined();
  });
});
