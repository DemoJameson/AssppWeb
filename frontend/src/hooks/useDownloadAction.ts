import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import { useSettingsStore } from "../store/settings";
import { useAccountsStore } from "../store/accounts";
import { DownloadError, getDownloadInfo } from "../apple/download";
import { purchaseApp } from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { FAILURE_LICENSE_NOT_FOUND } from "../apple/config";
import { needsPlatformPin } from "../apple/platform";
import { repeatUnreachable } from "../apple/retry";
import { listVersions } from "../apple/versionFinder";
import { getVersionMetadata } from "../apple/versionLookup";
import { getCachedVersionList, versionListKey } from "../store/versionLists";
import { apiPost, apiGet } from "../api/client";
import {
  accountHash,
  accountHardwareId,
  accountStoreCountry,
} from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { findDuplicateDownload } from "../utils/downloaded";
import { needsVersionExchange } from "../utils/software";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

/**
 * The version a download falls back to when its caller named none. tvOS,
 * visionOS and macOS must carry a version id (`needsPlatformPin`) — a delisted
 * app has neither a catalogue entry nor a recorded pin, so borrow the version
 * list's newest entry (what the list exchange was pinned to): no extra Apple
 * traffic, same footing as picking that version. iOS needs no pin, left alone.
 */
function versionPinFallback(
  app: Software,
  account: Account,
  country?: string,
): string | undefined {
  if (!needsPlatformPin(app.platform)) return undefined;
  // The cache is keyed by the region the exchange ran under: `country` matches
  // the page's write even on the first frame, else the account's storefront.
  const region = country ?? accountStoreCountry(account);
  return getCachedVersionList(
    versionListKey(app.id, app.platform, region),
  )?.[0];
}

/** The newest build an app still serves, as `lookupNewestServableVersion` finds it. */
export interface ServableVersion {
  /** Apple's id of the newest build the list names. */
  versionId: string;
  /** The build's own version number, when an exchange could name one. */
  displayVersion?: string;
  /** The app's builds, newest first — what an update picker offers. */
  versions: string[];
}

/**
 * Shared hook for download & purchase actions, deduping the flow across pages.
 * Actions keep a stable identity for as long as their dependencies do — pages
 * use them as effect dependencies, so a new one per render would re-run those
 * effects and, when they read the backend and write a subscribed store, loop.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  /**
   * Acquires the app's license, silently renewing the password token first (a
   * stale token fails the purchase). Returns the account with fresh cookies.
   */
  const acquireLicenseFor = useCallback(
    async (account: Account, app: Software): Promise<Account> => {
      // Renew the password token first to avoid "token expired" (2034/2042)
      // errors that would otherwise need a manual re-authentication.
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

      // The license grant has no fallback host, so an unanswered request is
      // repeated once — idempotent on Apple's side (a repeat returns "already
      // owned"); `repeatUnreachable` still refuses a started response.
      const result = await repeatUnreachable(() =>
        purchaseApp(currentAccount, app),
      );
      const updated = { ...currentAccount, cookies: result.updatedCookies };
      await updateAccount(updated);
      return updated;
    },
    [updateAccount],
  );

  const startDownload = useCallback(async (
    account: Account,
    app: Software,
    versionId?: string,
    country?: string,
  ) => {
    const ctx = getAccountContext(account, t);
    const appName = app.name;
    const pin = versionId || versionPinFallback(app, account, country);

    // A build this account already holds (or is fetching) would be a second copy;
    // the same build under another account is its own package. Re-read the queue
    // first — it moves on its own and a page opened from search may never have
    // read it — and hash the account as it stands, since the rows share that digest.
    const accountKey = await accountHash(account);
    await fetchTasks();
    const duplicate = findDuplicateDownload(
      useDownloadsStore.getState().tasks,
      app,
      pin,
      accountKey,
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

    // No license yet (FAILURE_LICENSE_NOT_FOUND) → acquire one and retry once.
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

    // The app id is the identity (ipatool's `App.ID`); the bundle id comes from
    // the storefront or the download item, or is left empty and read from the
    // compiled package (a download created from a bare app id).
    const bundleID = app.bundleID || output.bundleID || "";

    // The record's date and size were quoted for one build, so they travel only
    // when the download reply confirms that version (a picker can serve an older
    // build; `needsVersionExchange` covers a recalled record). The package then
    // supplies them. App-level facts (name, artist, genre, artwork) always travel.
    const quotedForServedBuild =
      !needsVersionExchange(app) &&
      !!app.version &&
      app.version === output.bundleShortVersionString;

    // The account the package is filed under — the session the license step may
    // have refreshed — whose digest keys the finished task.
    const hash = await accountHash(currentAccount);

    // A macOS package must be decrypted on this side, which needs the key material
    // from Apple's reply and the hardware id the download was requested with.
    // Both are refused up front so an unopenable package is never fetched.
    let decryption: { dpInfo?: string; hardwareId?: string } = {};
    if (app.platform === "macos") {
      const hardwareId = accountHardwareId(currentAccount);
      if (!output.dpInfo) {
        throw new DownloadError(t("errors.download.missingDPInfo"));
      }
      if (!hardwareId) {
        throw new DownloadError(t("errors.download.missingHardwareId"));
      }
      decryption = { dpInfo: output.dpInfo, hardwareId };
    }

    await apiPost("/api/downloads", {
      software: {
        ...app,
        bundleID,
        version: output.bundleShortVersionString,
        // The id of the build Apple served — recorded as the app+platform's
        // last-known pin. Only a storefront record's own id may stand in when the
        // reply omits it (a recalled record's id belongs to its recalled-from build).
        externalVersionId:
          output.externalVersionId ??
          (quotedForServedBuild ? app.externalVersionId : undefined),
        ...(quotedForServedBuild
          ? {}
          : {
              releaseDate: "",
              fileSizeBytes: undefined,
              // The floor belongs to the build the record quoted, so it drops
              // with that build's facts; the package supplies this build's own.
              minimumOsVersion: "",
            }),
      },
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      iTunesMetadata: output.iTunesMetadata,
      ...decryption,
    });

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
  }, [acquireLicenseFor, addToast, fetchTasks, t, updateAccount]);

  const acquireLicense = useCallback(
    async (account: Account, app: Software) => {
      const ctx = getAccountContext(account, t);
      const appName = app.name;

      await acquireLicenseFor(account, app);

      addToast(
        t("toast.msg", { appName, ...ctx }),
        "success",
        t("toast.title.licenseSuccess"),
      );
    },
    [acquireLicenseFor, addToast, t],
  );

  /**
   * Lists an app's versions, acquiring the license first when Apple reports none
   * (the exchange needs a license too). Fresh cookies are stored either way.
   */
  const listVersionsWithLicense = useCallback(
    async (
      account: Account,
      app: Software,
      pinnedVersionId?: string,
    ): Promise<Awaited<ReturnType<typeof listVersions>>> => {
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
    },
    [acquireLicenseFor, addToast, t, updateAccount],
  );

  /**
   * Newest build an app still serves, with its display version — the update check
   * for a delisted app (the catalogue and the backend's package index can never
   * see one). The version exchange, pinned to a recorded build, outlives
   * delisting: its newest-first entry is the newest servable build, named by a
   * second pinned exchange. Undefined = the list named nothing ("could not be
   * told", not "up to date").
   */
  const lookupNewestServableVersion = useCallback(
    async (
      account: Account,
      app: Software,
      recordedVersionId?: string,
    ): Promise<ServableVersion | undefined> => {
      const pinned = recordedVersionId?.trim() || undefined;
      const list = await listVersionsWithLicense(account, app, pinned);
      const versionId = list.versions[0];
      if (!versionId) return undefined;

      // The list's newest build is the one already held: nothing newer to name.
      if (pinned && versionId === pinned) {
        return { versionId, versions: list.versions };
      }

      // The license/list steps may have refreshed the session, so run on the
      // account as it now stands, not the caller's snapshot.
      const freshest =
        useAccountsStore
          .getState()
          .accounts.find((stored) => stored.email === account.email) ?? account;

      try {
        const { metadata, updatedCookies } = await getVersionMetadata(
          freshest,
          app,
          versionId,
        );
        try {
          await updateAccount({ ...freshest, cookies: updatedCookies });
        } catch {
          // Bookkeeping only — the answer matters more than the session it came
          // with, the same trade the silent version fill makes.
        }
        return {
          versionId,
          displayVersion: metadata.displayVersion,
          versions: list.versions,
        };
      } catch {
        return { versionId, versions: list.versions };
      }
    },
    [listVersionsWithLicense, updateAccount],
  );

  const toastDownloadError = useCallback(
    (account: Account, app: Software, error: unknown) => {
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
    },
    [addToast, t],
  );

  const toastLicenseError = useCallback(
    (account: Account, app: Software, error: unknown) => {
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
    },
    [addToast, t],
  );

  return {
    startDownload,
    acquireLicense,
    listVersionsWithLicense,
    lookupNewestServableVersion,
    toastDownloadError,
    toastLicenseError,
  };
}
