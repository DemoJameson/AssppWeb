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

/** The newest build an app still serves, as `lookupNewestServableVersion` finds
 * it: the id to fetch, the number to name it by, and the list to pick from. */
export interface ServableVersion {
  /** Apple's id of the newest build the list names. */
  versionId: string;
  /** The build's own version number, when an exchange could name one. */
  displayVersion?: string;
  /** The app's builds, newest first — what an update picker offers. */
  versions: string[];
}

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across the pages that trigger downloads.
 *
 * Every action it hands out keeps a stable identity for as long as the pieces
 * it closes over do: pages take them as dependencies of their effects (the
 * detail page's version-list probe, the search page's), and an action that is
 * new on every render would re-run those effects on every render — which, for
 * an effect that reads the backend and writes a store the page subscribes to,
 * is a request loop.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  /**
   * Acquires the app's license, silently renewing the password token first (a
   * stale token would fail the purchase). Returns the account with the fresh
   * cookies so the caller can keep using the same session.
   */
  const acquireLicenseFor = useCallback(
    async (account: Account, app: Software): Promise<Account> => {
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

      // The license grant is the download flow's one request with nowhere else
      // to go: unlike the download-product exchange, it has no fallback host to
      // move to. A request Apple never answered is repeated once — the grant is
      // idempotent on Apple's side (a repeat comes back as "already owned"), and
      // `repeatUnreachable` still refuses to repeat one whose response had
      // already started arriving, where the answer could be a duplicate.
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

    // A build *this account* already holds — or is still fetching — would only
    // become a second copy of the same package; the same build under another
    // account is a package of its own, and asking for it there is the point.
    // The queue is re-read first: it moves on its own, and a page opened
    // straight from search may never have read it at all. The hash is taken
    // from the account as it stands — the rows in that queue are keyed by the
    // same digest, so the comparison lands on the tasks this account can see.
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

    // The account the package is filed under: the session the license step may
    // have refreshed, whose digest is the key the finished task is listed by.
    const hash = await accountHash(currentAccount);

    // A macOS package has to be decrypted once it lands, and only this side
    // holds what that takes: the key material from Apple's reply and the
    // hardware id the download was requested with. Both are refused up front
    // when they are missing, so a package that nothing can open is never
    // fetched.
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
        // The id of the build Apple served — the reply names it, and the
        // backend records it as the app+platform's last-known pin. Only a
        // storefront record's own id may stand in when the reply omits it: a
        // recalled record's id belongs to the build it was recalled from.
        externalVersionId:
          output.externalVersionId ??
          (quotedForServedBuild ? app.externalVersionId : undefined),
        ...(quotedForServedBuild
          ? {}
          : { releaseDate: "", fileSizeBytes: undefined }),
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
   * Lists an app's versions, acquiring the license first when Apple reports
   * that the account has none yet — the version exchange requires a license
   * just like a download does. The refreshed session cookies are stored on
   * the account either way, and the list is returned to the caller.
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
   * The newest build an app still serves, with the version number to name it by
   * — the answer to "is there an update" for an app the storefront has
   * forgotten.
   *
   * A listed app needs none of this: the catalogue's own `version` is the
   * newest, so `lookupApp` answers for it alone. A delisted app is what this
   * exists for. The catalogue has nothing left for it, and the package-app index
   * the backend falls back to only describes the build already on disk — so a
   * check comparing against *that* can never see an update, however long the app
   * has moved on. The version exchange is the channel that outlives delisting:
   * pinned to a build recorded for the app (`versionPins`), it answers with the
   * app's version list, whose newest entry — the list arrives newest first — is
   * the newest *servable* build.
   *
   * One further pinned exchange then reads that build's display version, which
   * is the number an update message reports. It is skipped when the list's
   * newest build is the one recorded, which is the no-update case and needs no
   * number. A build the exchange will not describe is still an answer — it is
   * servable, and the caller can name it by its id. Undefined only when the list
   * names no build at all, which is not "up to date" but "could not be told".
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

      // The newest build the list names is the one already held: nothing newer to
      // name, and so nothing for a second exchange to describe.
      if (pinned && versionId === pinned) {
        return { versionId, versions: list.versions };
      }

      // The license step — and the list before it — may have refreshed the
      // session, so the exchange runs on the account as it now stands rather than
      // on the caller's snapshot.
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
