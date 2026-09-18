import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import { useSettingsStore } from "../store/settings";
import { DownloadError, getDownloadInfo } from "../apple/download";
import { purchaseApp } from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { FAILURE_LICENSE_NOT_FOUND } from "../apple/config";
import { listVersions } from "../apple/versionFinder";
import { apiPost, apiGet } from "../api/client";
import { accountHash } from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    try {
      const settings = await apiGet<{ maxDownloadMB: number }>("/api/settings");
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t("toast.downloadLimit.message", {
              appName,
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            "error",
            t("toast.title.downloadLimit"),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    // If Apple answers that the account has no license for this app yet,
    // acquire one and retry the download once before giving up.
    let currentAccount = account;
    let download: Awaited<ReturnType<typeof getDownloadInfo>>;
    try {
      download = await getDownloadInfo(currentAccount, app, versionId);
    } catch (err) {
      if (
        !(err instanceof DownloadError) ||
        err.code !== FAILURE_LICENSE_NOT_FOUND ||
        !useSettingsStore.getState().autoAcquireLicense
      ) {
        throw err;
      }

      currentAccount = await acquireLicenseFor(currentAccount, app);
      addToast(
        t("toast.msg", { appName, ...ctx }),
        "success",
        t("toast.title.licenseSuccess"),
      );

      download = await getDownloadInfo(currentAccount, app, versionId);
    }

    const { output, updatedCookies } = download;
    await updateAccount({ ...currentAccount, cookies: updatedCookies });

    // The app id is the identity here (ipatool's `App.ID`); the bundle id is
    // whatever the storefront or the download item reports. When neither knows
    // it — a download created from a bare app id — it is left empty and the backend
    // reads it out of the compiled package.
    const bundleID = app.bundleID || output.bundleID || "";

    const hash = await accountHash(currentAccount);

    await apiPost("/api/downloads", {
      software: {
        ...app,
        bundleID,
        version: output.bundleShortVersionString,
        // The id of the build Apple served; the backend records it as the
        // app+platform's last-known pin for future version queries.
        externalVersionId: output.externalVersionId ?? app.externalVersionId,
      },
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      iTunesMetadata: output.iTunesMetadata,
    });

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
  }

  /**
   * Acquires the app's license, silently renewing the password token first (a
   * stale token would fail the purchase). Returns the account with the fresh
   * cookies so the caller can keep using the same session.
   */
  async function acquireLicenseFor(
    account: Account,
    app: Software,
  ): Promise<Account> {
    // Silently renew the password token before purchasing. This prevents
    // "token expired" (2034/2042) errors that would otherwise require the
    // user to manually re-authenticate.
    let currentAccount = account;
    try {
      const renewed = await authenticate(
        account.email,
        account.password,
        undefined,
        account.cookies,
        account.deviceIdentifier,
      );
      await updateAccount(renewed);
      currentAccount = renewed;
    } catch {
      // Ignore — proceed with existing token
    }

    const result = await purchaseApp(currentAccount, app);
    const updated = { ...currentAccount, cookies: result.updatedCookies };
    await updateAccount(updated);
    return updated;
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    await acquireLicenseFor(account, app);

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "success",
      t("toast.title.licenseSuccess"),
    );
  }

  /**
   * Lists an app's versions, acquiring the license first when Apple reports
   * that the account has none yet — the version exchange requires a license
   * just like a download does. The refreshed session cookies are stored on
   * the account either way, and the list is returned to the caller.
   */
  async function listVersionsWithLicense(
    account: Account,
    app: Software,
    pinnedVersionId?: string,
  ): Promise<Awaited<ReturnType<typeof listVersions>>> {
    let currentAccount = account;
    let result: Awaited<ReturnType<typeof listVersions>>;
    try {
      result = await listVersions(currentAccount, app, pinnedVersionId);
    } catch (err) {
      if (
        !(err instanceof DownloadError) ||
        err.code !== FAILURE_LICENSE_NOT_FOUND ||
        !useSettingsStore.getState().autoAcquireLicense
      ) {
        throw err;
      }

      const ctx = getAccountContext(account, t);
      currentAccount = await acquireLicenseFor(currentAccount, app);
      addToast(
        t("toast.msg", { appName: app.name, ...ctx }),
        "success",
        t("toast.title.licenseSuccess"),
      );

      result = await listVersions(currentAccount, app, pinnedVersionId);
    }

    await updateAccount({ ...currentAccount, cookies: result.updatedCookies });
    return result;
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.downloadFailed")),
      }),
      "error",
      t("toast.title.downloadFailed"),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.licenseFailed")),
      }),
      "error",
      t("toast.title.licenseFailed"),
    );
  }

  return {
    startDownload,
    acquireLicense,
    listVersionsWithLicense,
    toastDownloadError,
    toastLicenseError,
  };
}
