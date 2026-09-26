import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadAction } from "../../src/hooks/useDownloadAction";
import { DownloadError, getDownloadInfo } from "../../src/apple/download";
import { AppleUnreachableError } from "../../src/apple/errors";
import { listVersions } from "../../src/apple/versionFinder";
import { getVersionMetadata } from "../../src/apple/versionLookup";
import { purchaseApp } from "../../src/apple/purchase";
import { authenticate } from "../../src/apple/authenticate";
import { apiGet, apiPost } from "../../src/api/client";
import { useToastStore } from "../../src/store/toast";
import { useAccountsStore } from "../../src/store/accounts";
import { useSettingsStore } from "../../src/store/settings";
import {
  rememberVersionList,
  useVersionListsStore,
  versionListKey,
} from "../../src/store/versionLists";
import { accountHash } from "../../src/utils/account";
import type { Account, DownloadTask, Software } from "../../src/types";

const mocks = vi.hoisted(() => ({
  updateAccount: vi.fn(),
  fetchTasks: vi.fn(),
  tasks: [] as DownloadTask[],
  /** One `t` for the whole file: the identity `useTranslation` really keeps. */
  stableT: (key: string) => key,
}));

vi.mock("react-i18next", () => ({
  // `t` keeps one identity per language in the real react-i18next (it lives in
  // a useState, see its useTranslation), and the hook's actions take `t` as a
  // useCallback dependency: a mock that hands out a fresh arrow per render
  // would make every action unstable for a reason the app does not have.
  useTranslation: () => ({ t: mocks.stableT }),
  // The real i18n module (pulled in via apple/download) still initialises,
  // so the plugin slot has to exist.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({ updateAccount: mocks.updateAccount }),
}));

vi.mock("../../src/store/downloads", () => ({
  useDownloadsStore: Object.assign(
    (
      selector: (state: {
        fetchTasks: () => void;
        tasks: DownloadTask[];
      }) => unknown,
    ) => selector({ fetchTasks: mocks.fetchTasks, tasks: mocks.tasks }),
    { getState: () => ({ fetchTasks: mocks.fetchTasks, tasks: mocks.tasks }) },
  ),
}));

vi.mock("../../src/apple/download", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/apple/download")>();
  return { ...actual, getDownloadInfo: vi.fn() };
});

vi.mock("../../src/apple/purchase", () => ({
  purchaseApp: vi.fn(),
}));

vi.mock("../../src/apple/versionFinder", () => ({
  listVersions: vi.fn(),
}));

// The newest servable build's version number comes from a pinned download
// exchange; the module is stubbed so its transport stays out of the graph.
vi.mock("../../src/apple/versionLookup", () => ({
  getVersionMetadata: vi.fn(),
}));

vi.mock("../../src/apple/authenticate", () => ({
  authenticate: vi.fn(),
}));

// Keep the libcurl-backed transport out of the import graph entirely —
// download.ts (imported for its real DownloadError) pulls it in otherwise.
vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const account: Account = {
  email: "dev@example.test",
  password: "secret",
  appleId: "dev@example.test",
  store: "143441",
  firstName: "Dev",
  lastName: "Tester",
  passwordToken: "old-token",
  directoryServicesIdentifier: "123456789",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
};

// The key the queue files a package under: the duplicate check asks whether
// *this* account holds the build, so a fixture task has to wear this account's
// digest to speak for it (see `utils/downloaded`).
const accountKey = await accountHash(account);

const app: Software = {
  id: 1492142120,
  bundleID: "com.example.utility",
  name: "Example Utility",
  version: "3.4.5",
  price: 0,
  artistName: "Example Developer",
  sellerName: "Example Developer LLC",
  description: "A test application.",
  averageUserRating: 4.8,
  userRatingCount: 42,
  artworkUrl: "",
  screenshotUrls: [],
  minimumOsVersion: "16.0",
  releaseDate: "2026-08-01T00:00:00Z",
  primaryGenreName: "Utilities",
};

const output = {
  downloadURL: "https://iosapps.example.com/app.ipa",
  sinfs: [],
  bundleShortVersionString: "3.4.5",
  bundleVersion: "345",
  bundleID: "com.example.utility",
};

describe("useDownloadAction", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useVersionListsStore.setState({ lists: {} });
    // The hook re-reads the session from here; no account unless a test puts
    // one back (the one the license step would have stored).
    useAccountsStore.setState({ accounts: [] });
    useSettingsStore.setState({
      autoFetchVersionInfo: true,
      autoAcquireLicense: true,
    });
    mocks.updateAccount.mockReset();
    mocks.updateAccount.mockResolvedValue(undefined);
    mocks.fetchTasks.mockReset();
    // Nothing downloaded unless a test says otherwise.
    mocks.tasks = [];
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiGet).mockResolvedValue({ maxDownloadMB: 0 });
    vi.mocked(apiPost).mockReset();
    vi.mocked(apiPost).mockResolvedValue({});
    vi.mocked(authenticate).mockReset();
    vi.mocked(authenticate).mockResolvedValue({
      ...account,
      passwordToken: "fresh-token",
    });
    vi.mocked(purchaseApp).mockReset();
    vi.mocked(purchaseApp).mockResolvedValue({ updatedCookies: [] });
    vi.mocked(getDownloadInfo).mockReset();
    vi.mocked(getDownloadInfo).mockResolvedValue({ output, updatedCookies: [] });
    vi.mocked(listVersions).mockReset();
    vi.mocked(listVersions).mockResolvedValue({
      versions: ["333", "222"],
      updatedCookies: [],
    });
    vi.mocked(getVersionMetadata).mockReset();
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata: { displayVersion: "3.4.6", releaseDate: "2026-08-02T00:00:00Z" },
      updatedCookies: [],
    });
  });

  it("acquires the license and retries when Apple reports it missing", async () => {
    vi.mocked(getDownloadInfo)
      .mockRejectedValueOnce(new DownloadError("license", "9610"))
      .mockResolvedValueOnce({ output, updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(purchaseApp).toHaveBeenCalledTimes(1);
    expect(getDownloadInfo).toHaveBeenCalledTimes(2);
    expect(apiPost).toHaveBeenCalledWith(
      "/api/downloads",
      expect.objectContaining({ accountHash: expect.any(String) }),
    );

    const titles = useToastStore.getState().toasts.map((toast) => toast.title);
    expect(titles).toContain("toast.title.licenseSuccess");
    expect(titles).toContain("toast.title.downloadStarted");
  });

  it("retries with the session the purchase refreshed", async () => {
    vi.mocked(getDownloadInfo)
      .mockRejectedValueOnce(new DownloadError("license", "9610"))
      .mockResolvedValueOnce({ output, updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    const retryAccount = vi.mocked(getDownloadInfo).mock.calls[1][0];
    expect(retryAccount.passwordToken).toBe("fresh-token");
  });

  it("leaves a recalled record's per-build facts out of the request", async () => {
    // A record recalled from the package index describes the build it was
    // recalled from, while the picker can serve a different one. The date is
    // re-read from the archive that arrives and the size measured on disk, so
    // carrying the record's values would hand the task another build's day.
    const recalled: Software = {
      ...app,
      metadataSource: "local",
      // The record carries its own build's id; the request must not pass it on
      // as the served build's (the backend pins whatever arrives here).
      externalVersionId: "888154623",
      releaseDate: "2026-07-11T00:00:00Z",
      fileSizeBytes: "155759893",
    };

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, recalled);
    });

    const body = vi.mocked(apiPost).mock.calls[0][1];
    expect(body.software.releaseDate).toBe("");
    expect(body.software.fileSizeBytes).toBeUndefined();
    expect(body.software.externalVersionId).toBeUndefined();
    // The app's own facts still travel, and the served build names itself.
    expect(body.software.name).toBe(app.name);
    expect(body.software.artistName).toBe(app.artistName);
    expect(body.software.bundleID).toBe(app.bundleID);
    expect(body.software.version).toBe(output.bundleShortVersionString);
  });

  it("keeps a storefront record's own values when it named the served build", async () => {
    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, {
        ...app,
        // The reply names no build, so the record's own id may stand in for it.
        externalVersionId: "890657720",
        fileSizeBytes: "5242880",
      });
    });

    const body = vi.mocked(apiPost).mock.calls[0][1];
    expect(body.software.releaseDate).toBe(app.releaseDate);
    expect(body.software.fileSizeBytes).toBe("5242880");
    expect(body.software.externalVersionId).toBe("890657720");
  });

  it("drops them when Apple serves another version than the record named", async () => {
    // The storefront's date is the *current* version's; picking an older build
    // in the picker (or the update dialog) serves that one instead, so the date
    // on hand is another build's — the compiled package supplies its own.
    vi.mocked(getDownloadInfo).mockResolvedValue({
      output: { ...output, bundleShortVersionString: "3.4.4" },
      updatedCookies: [],
    });

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, {
        ...app,
        externalVersionId: "890657720",
        fileSizeBytes: "5242880",
      });
    });

    const body = vi.mocked(apiPost).mock.calls[0][1];
    expect(body.software.version).toBe("3.4.4");
    expect(body.software.releaseDate).toBe("");
    expect(body.software.fileSizeBytes).toBeUndefined();
    expect(body.software.externalVersionId).toBeUndefined();
  });

  it("does not purchase for unrelated failures", async () => {
    vi.mocked(getDownloadInfo).mockRejectedValueOnce(
      new DownloadError("boom", "5002"),
    );

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await expect(
        result.current.startDownload(account, app),
      ).rejects.toThrow("boom");
    });

    expect(purchaseApp).not.toHaveBeenCalled();
    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("propagates the purchase failure without retrying", async () => {
    vi.mocked(getDownloadInfo).mockRejectedValueOnce(
      new DownloadError("license", "9610"),
    );
    vi.mocked(purchaseApp).mockRejectedValue(new Error("purchase failed"));

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await expect(
        result.current.startDownload(account, app),
      ).rejects.toThrow("purchase failed");
    });

    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("asks again for a license Apple never answered", async () => {
    vi.mocked(getDownloadInfo)
      .mockRejectedValueOnce(new DownloadError("license", "9610"))
      .mockResolvedValueOnce({ output, updatedCookies: [] });
    // The storefront host's pool leaves connections silent (see AGENTS.md), so
    // a grant that never reached Apple is worth one more try.
    vi.mocked(purchaseApp)
      .mockRejectedValueOnce(new AppleUnreachableError("Apple did not answer"))
      .mockResolvedValueOnce({ updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(purchaseApp).toHaveBeenCalledTimes(2);
    expect(apiPost).toHaveBeenCalledWith(
      "/api/downloads",
      expect.objectContaining({ accountHash: expect.any(String) }),
    );
  });

  it("gives up on a license that stayed unanswered twice", async () => {
    vi.mocked(getDownloadInfo).mockRejectedValueOnce(
      new DownloadError("license", "9610"),
    );
    vi.mocked(purchaseApp).mockRejectedValue(
      new AppleUnreachableError("Apple did not answer"),
    );

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await expect(
        result.current.startDownload(account, app),
      ).rejects.toThrow("Apple did not answer");
    });

    expect(purchaseApp).toHaveBeenCalledTimes(2);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("downloads directly when a license already exists", async () => {
    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(purchaseApp).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
  });

  it("hands the server what a macOS package is decrypted with", async () => {
    // Apple's macOS packages arrive encrypted, and the two pieces that open
    // them — the key material from the reply and the hardware id the download
    // was requested with — exist only on this side of the boundary.
    const macApp = { ...app, platform: "macos" as const };
    vi.mocked(getDownloadInfo).mockResolvedValue({
      output: { ...output, dpInfo: "QUJDRA==" },
      updatedCookies: [],
    });

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, macApp);
    });

    expect(apiPost).toHaveBeenCalledWith(
      "/api/downloads",
      expect.objectContaining({
        dpInfo: "QUJDRA==",
        hardwareId: account.deviceIdentifier,
      }),
    );
  });

  it("leaves the decryption out of a download that needs none", async () => {
    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    const body = vi.mocked(apiPost).mock.calls[0][1];
    expect(body.dpInfo).toBeUndefined();
    expect(body.hardwareId).toBeUndefined();
  });

  it("refuses a macOS download this account could not decrypt", async () => {
    // A device id that is not hex — an imported serial number, say — cannot be
    // the hardware id StoreAgent derives its key from, so the package is never
    // fetched: nothing could open it.
    const macApp = { ...app, platform: "macos" as const };
    vi.mocked(getDownloadInfo).mockResolvedValue({
      output: { ...output, dpInfo: "QUJDRA==" },
      updatedCookies: [],
    });

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await expect(
        result.current.startDownload(
          { ...account, deviceIdentifier: "C02XK1AB" },
          macApp,
        ),
      ).rejects.toThrow("errors.download.missingHardwareId");
    });

    expect(apiPost).not.toHaveBeenCalled();
  });

  /** A package the account holds — downloading it again is a duplicate. */
  function heldTask(overrides: {
    version?: string;
    externalVersionId?: string;
    platform?: Software["platform"];
    status?: DownloadTask["status"];
    accountHash?: string;
  } = {}): DownloadTask {
    return {
      id: "held",
      software: {
        ...app,
        version: overrides.version ?? app.version,
        platform: overrides.platform ?? app.platform,
        externalVersionId: overrides.externalVersionId,
      },
      accountHash: overrides.accountHash ?? accountKey,
      status: overrides.status ?? "completed",
      progress: 100,
      speed: "",
      createdAt: "2026-09-20T00:00:00.000Z",
    };
  }

  it("refuses a pinned build the account already holds", async () => {
    mocks.tasks = [heldTask({ externalVersionId: "900" })];

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app, "900");
    });

    expect(mocks.fetchTasks).toHaveBeenCalled();
    expect(getDownloadInfo).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
    const titles = useToastStore.getState().toasts.map((toast) => toast.title);
    expect(titles).toEqual(["toast.title.alreadyDownloaded"]);
  });

  it("downloads the same build for another account", async () => {
    // The build is already here under a different account. A package belongs to
    // the account that fetched it, so asking for it here is not a repeat — the
    // queue's copy of it is not this account's.
    mocks.tasks = [
      heldTask({ externalVersionId: "900", accountHash: "another-account" }),
    ];

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app, "900");
    });

    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalled();
  });

  it("refuses a repeat of the version the record names", async () => {
    // Nothing pinned: Apple picks the build, so the record's own version
    // number is the only thing the request can be identified by.
    mocks.tasks = [heldTask({ version: "3.4.5" })];

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(getDownloadInfo).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("still downloads a newer version than the one held", async () => {
    mocks.tasks = [heldTask({ version: "3.4.4" })];

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(apiPost).toHaveBeenCalled();
  });

  it("lets a retry through when the earlier attempt failed", async () => {
    mocks.tasks = [heldTask({ version: "3.4.5", status: "failed" })];

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalled();
  });

  it("does not count another platform's package as a duplicate", async () => {
    mocks.tasks = [heldTask({ version: "3.4.5", platform: "tvos" })];

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, { ...app, platform: "ios" });
    });

    expect(apiPost).toHaveBeenCalled();
  });

  it("borrows the cached newest version when the platform needs a pin", async () => {
    // A tvOS download has to name a version id up front; for a delisted app the
    // catalogue and the recorded pin both have nothing, but the version list —
    // fetched through the pin guess — names real builds, so its newest entry is
    // borrowed instead of failing with "no version to pin".
    const tvosApp = { ...app, platform: "tvos" as const };
    rememberVersionList(versionListKey(app.id, "tvos", "US"), ["900", "800"]);

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, tvosApp);
    });

    expect(getDownloadInfo).toHaveBeenCalledWith(account, tvosApp, "900");
  });

  it("borrows the pin from the page's region when one is supplied", async () => {
    // The page keys its list cache with its own `country` state; on the first
    // frame that can differ from the account's storefront, so the fallback must
    // read the key the page wrote under.
    const tvosApp = { ...app, platform: "tvos" as const };
    rememberVersionList(versionListKey(app.id, "tvos", "JP"), ["900"]);

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, tvosApp, undefined, "JP");
    });

    expect(getDownloadInfo).toHaveBeenCalledWith(account, tvosApp, "900");
  });

  it("lets an explicit version win over the cached one", async () => {
    const tvosApp = { ...app, platform: "tvos" as const };
    rememberVersionList(versionListKey(app.id, "tvos", "US"), ["900", "800"]);

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, tvosApp, "800");
    });

    expect(getDownloadInfo).toHaveBeenCalledWith(account, tvosApp, "800");
  });

  it("passes no version when the platform needs no pin, cache or not", async () => {
    // iOS keeps the historical unpinned request: pinning it would narrow what
    // the account may receive for no reason.
    rememberVersionList(versionListKey(app.id, "ios"), ["900"]);

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(getDownloadInfo).toHaveBeenCalledWith(account, app, undefined);
  });

  it("passes no version when a pinned platform has no cached list", async () => {
    const tvosApp = { ...app, platform: "tvos" as const };

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, tvosApp);
    });

    expect(getDownloadInfo).toHaveBeenCalledWith(account, tvosApp, undefined);
  });

  it("reuses the borrowed pin for the retry after a purchase", async () => {
    const tvosApp = { ...app, platform: "tvos" as const };
    rememberVersionList(versionListKey(app.id, "tvos", "US"), ["900"]);
    vi.mocked(getDownloadInfo)
      .mockRejectedValueOnce(new DownloadError("license", "9610"))
      .mockResolvedValueOnce({ output, updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, tvosApp);
    });

    expect(getDownloadInfo).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getDownloadInfo).mock.calls[1][2]).toBe("900");
  });

  it("lists versions and stores the refreshed session", async () => {
    const { result } = renderHook(() => useDownloadAction());
    let versions: string[] = [];
    await act(async () => {
      versions = (
        await result.current.listVersionsWithLicense(account, app)
      ).versions;
    });

    expect(versions).toEqual(["333", "222"]);
    expect(purchaseApp).not.toHaveBeenCalled();
    expect(mocks.updateAccount).toHaveBeenCalledTimes(1);
  });

  it("acquires the license and retries when the version list needs one", async () => {
    vi.mocked(listVersions)
      .mockRejectedValueOnce(new DownloadError("license", "9610"))
      .mockResolvedValueOnce({ versions: ["333"], updatedCookies: [] });

    const { result } = renderHook(() => useDownloadAction());
    let versions: string[] = [];
    await act(async () => {
      versions = (
        await result.current.listVersionsWithLicense(account, app)
      ).versions;
    });

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(purchaseApp).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledTimes(2);
    expect(versions).toEqual(["333"]);
    const titles = useToastStore.getState().toasts.map((toast) => toast.title);
    expect(titles).toContain("toast.title.licenseSuccess");
  });

  it("propagates other version list failures", async () => {
    vi.mocked(listVersions).mockRejectedValueOnce(
      new DownloadError("boom", "5002"),
    );

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await expect(
        result.current.listVersionsWithLicense(account, app),
      ).rejects.toThrow("boom");
    });

    expect(purchaseApp).not.toHaveBeenCalled();
    expect(listVersions).toHaveBeenCalledTimes(1);
  });

  it("does not auto-acquire the license when the automation switch is off", async () => {
    useSettingsStore.setState({ autoAcquireLicense: false });
    vi.mocked(getDownloadInfo).mockRejectedValueOnce(
      new DownloadError("license", "9610"),
    );

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await expect(result.current.startDownload(account, app)).rejects.toThrow(
        "license",
      );
    });

    expect(purchaseApp).not.toHaveBeenCalled();
    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
  });

  it("does not auto-acquire for version lists when the switch is off", async () => {
    useSettingsStore.setState({ autoAcquireLicense: false });
    vi.mocked(listVersions).mockRejectedValueOnce(
      new DownloadError("license", "9610"),
    );

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await expect(
        result.current.listVersionsWithLicense(account, app),
      ).rejects.toThrow("license");
    });

    expect(purchaseApp).not.toHaveBeenCalled();
    expect(listVersions).toHaveBeenCalledTimes(1);
  });

  describe("lookupNewestServableVersion", () => {
    // The record the backend answers with for an app the storefront has
    // forgotten: the build already on disk, which is why its own version can
    // never be the comparison.
    const recalled: Software = {
      ...app,
      version: "3.4.4",
      externalVersionId: "222",
      metadataSource: "local",
    };

    it("names the newest build the list offers, with its version number", async () => {
      const { result } = renderHook(() => useDownloadAction());
      let found;
      await act(async () => {
        found = await result.current.lookupNewestServableVersion(
          account,
          recalled,
          recalled.externalVersionId,
        );
      });

      // The list is pinned to the build already held — the only pin a delisted
      // app can still be reached through — and its newest entry is the answer.
      expect(listVersions).toHaveBeenCalledWith(account, recalled, "222");
      expect(found).toEqual({
        versionId: "333",
        displayVersion: "3.4.6",
        versions: ["333", "222"],
      });
      expect(mocks.updateAccount).toHaveBeenCalledTimes(2);
    });

    it("stops at the list when its newest build is the one already held", async () => {
      vi.mocked(listVersions).mockResolvedValue({
        versions: ["222", "111"],
        updatedCookies: [],
      });

      const { result } = renderHook(() => useDownloadAction());
      let found;
      await act(async () => {
        found = await result.current.lookupNewestServableVersion(
          account,
          recalled,
          "222",
        );
      });

      expect(found).toEqual({ versionId: "222", versions: ["222", "111"] });
      // Nothing newer to describe, so no second exchange is spent on a number
      // the caller will not print.
      expect(getVersionMetadata).not.toHaveBeenCalled();
    });

    it("still names the build when the exchange will not describe it", async () => {
      vi.mocked(getVersionMetadata).mockRejectedValue(new Error("no metadata"));

      const { result } = renderHook(() => useDownloadAction());
      let found;
      await act(async () => {
        found = await result.current.lookupNewestServableVersion(
          account,
          recalled,
          "222",
        );
      });

      expect(found).toEqual({ versionId: "333", versions: ["333", "222"] });
    });

    it("answers with nothing when the list names no build", async () => {
      vi.mocked(listVersions).mockResolvedValue({
        versions: [],
        updatedCookies: [],
      });

      const { result } = renderHook(() => useDownloadAction());
      let found;
      await act(async () => {
        found = await result.current.lookupNewestServableVersion(
          account,
          recalled,
        );
      });

      expect(found).toBeUndefined();
    });

    it("reads the display version on the session the license step stored", async () => {
      // The list exchange may have renewed the session on its way, and the
      // stored account is where that lands — the caller's snapshot predates it,
      // so the second exchange must not run on that.
      vi.mocked(listVersions)
        .mockRejectedValueOnce(new DownloadError("license", "9610"))
        .mockResolvedValueOnce({ versions: ["333"], updatedCookies: [] });
      useAccountsStore.setState({
        accounts: [{ ...account, passwordToken: "stored-token" }],
      });

      const { result } = renderHook(() => useDownloadAction());
      await act(async () => {
        await result.current.lookupNewestServableVersion(account, recalled, "222");
      });

      expect(purchaseApp).toHaveBeenCalledTimes(1);
      const usedAccount = vi.mocked(getVersionMetadata).mock.calls[0][0];
      expect(usedAccount.passwordToken).toBe("stored-token");
    });
  });

  it("hands out actions of stable identity, so an effect does not re-run for having rendered", () => {
    // The detail page's probe effect takes these as dependencies. A closure that
    // is new on every render re-runs that effect on every render — and the
    // effect reads the backend and writes a store the page subscribes to, which
    // is the request loop `AGENTS.md` describes. Rendering again must hand the
    // same functions back.
    const { result, rerender } = renderHook(() => useDownloadAction());
    const first = result.current;

    rerender();

    expect(result.current.startDownload).toBe(first.startDownload);
    expect(result.current.acquireLicense).toBe(first.acquireLicense);
    expect(result.current.listVersionsWithLicense).toBe(
      first.listVersionsWithLicense,
    );
    expect(result.current.lookupNewestServableVersion).toBe(
      first.lookupNewestServableVersion,
    );
    expect(result.current.toastDownloadError).toBe(first.toastDownloadError);
    expect(result.current.toastLicenseError).toBe(first.toastLicenseError);
  });
});
