import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadAction } from "../../src/hooks/useDownloadAction";
import { DownloadError, getDownloadInfo } from "../../src/apple/download";
import { listVersions } from "../../src/apple/versionFinder";
import { purchaseApp } from "../../src/apple/purchase";
import { authenticate } from "../../src/apple/authenticate";
import { apiGet, apiPost } from "../../src/api/client";
import { useToastStore } from "../../src/store/toast";
import { useSettingsStore } from "../../src/store/settings";
import type { Account, Software } from "../../src/types";

const mocks = vi.hoisted(() => ({
  updateAccount: vi.fn(),
  fetchTasks: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The real i18n module (pulled in via apple/download) still initialises,
  // so the plugin slot has to exist.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({ updateAccount: mocks.updateAccount }),
}));

vi.mock("../../src/store/downloads", () => ({
  useDownloadsStore: (
    selector: (state: { fetchTasks: () => void }) => unknown,
  ) => selector({ fetchTasks: mocks.fetchTasks }),
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
    useSettingsStore.setState({
      autoFetchVersionInfo: true,
      autoAcquireLicense: true,
    });
    mocks.updateAccount.mockReset();
    mocks.updateAccount.mockResolvedValue(undefined);
    mocks.fetchTasks.mockReset();
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

  it("downloads directly when a license already exists", async () => {
    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    expect(purchaseApp).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
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
});
