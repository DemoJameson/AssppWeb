import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import { useSettingsStore } from "../store/settings";
import { DownloadError, getDownloadInfo } from "../apple/download";
import { purchaseApp } from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { FAILURE_LICENSE_NOT_FOUND } from "../apple/config";
import { needsPlatformPin } from "../apple/platform";
import { listVersions } from "../apple/versionFinder";
import { getCachedVersionList, versionListKey } from "../store/versionLists";
import { apiPost, apiGet } from "../api/client";
import { accountHash, accountStoreCountry } from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { findDuplicateDownload } from "../utils/downloaded";
import { needsVersionExchange } from "../utils/software";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

/**
 * The version a download falls back to when its caller named none. tvOS,
 * visionOS and macOS downloads must carry a version id (`needsPlatformPin`):
 * without one the exchange has to resolve it from the catalogue or from the
 * pin a past download recorded, and a delisted app has neither — it fails with
 * "no version to pin" even though the version list, fetched through the pin
 * guess, names real builds.
 *
 * The list's newest entry *is* such a build (it is what the list exchange was
 * pinned to), so borrowing it keeps the download on the same footing as picking
 * that version in the picker — no extra Apple traffic, and nothing to guess.
 * A platform that needs no pin is left alone: an unpinned iOS request is the
 * historical path, and pinning it would only narrow what the account may get.
 */
function versionPinFallback(
  app: Software,
  account: Account,
  country?: string,
): string | undefined {
  if (!needsPlatformPin(app.platform)) return undefined;
  // The cache is keyed by the region the exchange ran under. The page that
  // writes the list keys it with its own `country` state — the same source the
  // account's storefront is derived from — so an explicit region is used when
  // the caller has one (it matches the write even on the first frame, before
  // the account selection settles); otherwise the account's storefront is the
  // best available name for it.
  const region = country ?? accountStoreCountry(account);
  return getCachedVersionList(
    versionListKey(app.id, app.platform, region),
  )?.[0];
}

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across the pages that trigger downloads.
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
    country?: string,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;
    const pin = versionId || versionPinFallback(app, account, country);

    // A build the server already holds — or is still fetching — would only
    // become a second copy of the same package. The queue is re-read first:
    // it moves on its own, and a page opened straight from search may never
    // have read it at all.
    await fetchTasks();
    const duplicate = findDuplicateDownload(
      useDownloadsStore.getState().tasks,
      app,
      pin,
    );
    if (duplicate) {
      addToast(
        t("toast.alreadyDownloaded.message", { appName, ...ctx }),
        "info",
        t("toast.title.alreadyDownloaded"),
      );
      return;
    }

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
      download = await getDownloadInfo(currentAccount, app, pin);
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

      download = await getDownloadInfo(currentAccount, app, pin);
    }

    const { output, updatedCookies } = download;
    await updateAccount({ ...currentAccount, cookies: updatedCookies });

    // The app id is the identity here (ipatool's `App.ID`); the bundle id is
    // whatever the storefront or the download item reports. When neither knows
    // it — a download created from a bare app id — it is left empty and the backend
    // reads it out of the compiled package.
    const bundleID = app.bundleID || output.bundleID || "";

    // The record's per-build facts — its release date and its size — were
    // quoted for *one* build: the version the record names. The download reply
    // is the authority on which build is actually coming, so they only travel
    // when it confirms the same version. Two things fail that check: the picker
    // can hand back an older build than the storefront's current version, and a
    // recalled record is another build's download by nature (its `version` is
    // whatever that package happened to be — see `needsVersionExchange`).
    // Dropping them lets the compiled package supply the truth instead: its own
    // release date, read out of the archive, and the size the backend measures
    // after injection. Everything the record knows about the app itself (name,
    // artist, genre, artwork) still travels either way.
    const quotedForServedBuild =
      !needsVersionExchange(app) &&
      !!app.version &&
      app.version === output.bundleShortVersionString;

    const hash = await accountHash(currentAccount);

    await apiPost("/api/downloads", {
      software: {
        ...app,
        bundleID,
        version: output.bundleShortVersionString,
        // The id of the build Apple served; the backend records it as the
        // app+platform's last-known pin for future version queries.
        externalVersionId: output.externalVersionId ?? app.externalVersionId,
        ...(quotedForServedBuild
          ? {}
          : { releaseDate: "", fileSizeBytes: undefined }),
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
