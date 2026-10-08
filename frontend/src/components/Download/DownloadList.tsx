import { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Modal from "../common/Modal";
import ProgressBar from "../common/ProgressBar";
import Select from "../common/Select";
import Spinner from "../common/Spinner";
import DownloadItem from "./DownloadItem";
import {
  isDownloadPreviewEnabled,
  isPreviewDownloadTask,
  previewDownloadTasks,
} from "./previewTasks";
import { useDownloads } from "../../hooks/useDownloads";
import { isActiveDownload } from "../../store/downloads";
import { useAccounts } from "../../hooks/useAccounts";
import {
  useDownloadAction,
  type ServableVersion,
} from "../../hooks/useDownloadAction";
import { useVersionMetadataMap } from "../../hooks/useVersionMetadata";
import { useToastStore } from "../../store/toast";
import { lookupApp } from "../../api/search";
import { getErrorMessage } from "../../utils/error";
import { getAccountContext } from "../../utils/toast";
import { isNewerVersion } from "../../utils/version";
import { versionRowLabel } from "../../utils/versionLabels";
import { needsVersionExchange } from "../../utils/software";
import { storeIdToCountry } from "../../apple/config";
import type { Account, DownloadTask, Software } from "../../types";

/**
 * What the filter picks. `active` is the Downloads badge's bucket (queued,
 * transferring, compiling), not a status the rest of the UI treats separately.
 */
type StatusFilter = "all" | "active" | "paused" | "completed" | "failed";

/** Whether a task belongs to a filter pick. */
function matchesFilter(task: DownloadTask, pick: StatusFilter): boolean {
  if (pick === "all") return true;
  if (pick === "active") return isActiveDownload(task);
  return task.status === pick;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a row's update check found. `unknown` is deliberately not `current`: a
 * check that could not be made must not be reported as "up to date".
 */
type UpdateCheck =
  | {
      status: "newer";
      app: Software;
      /**
       * The build to fetch when one had to be named: a recalled record is
       * reached only through a pin; absent when the current version is fetched.
       */
      pin?: string;
      /** The version number the update message reports. */
      latestVersion: string;
      /** The app's builds, newest first, when the version exchange named them. */
      versions?: string[];
    }
  | { status: "current" }
  | { status: "unknown" };

/**
 * Whether the newest build an app still serves updates the row's build. Decided
 * by the version number from the exchange, else by the held build's position in
 * the list. Returns undefined (not "no update") when undecidable — no held id,
 * or the build missing from the list — rather than risk replacing a newer
 * package with an older one.
 */
function isNewerServable(
  newest: ServableVersion,
  task: DownloadTask,
): boolean | undefined {
  if (newest.displayVersion) {
    return isNewerVersion(newest.displayVersion, task.software.version);
  }

  const heldId = task.software.externalVersionId?.trim();
  if (!heldId) return undefined;

  const heldAt = newest.versions.indexOf(heldId);
  if (heldAt === -1) return undefined;
  return heldAt > 0;
}

/**
 * Asks what an app still serves for a row's platform and whether it is newer
 * than the row's build. Two sources: the storefront (its `version` is current,
 * the whole answer for a listed app), and when that record is a delisted one
 * describing only the build on disk, the version exchange
 * (`lookupNewestServableVersion`) pinned to a recorded build.
 */
async function checkForUpdate(
  account: Account,
  task: DownloadTask,
  country: string,
  lookupNewestServableVersion: (
    account: Account,
    app: Software,
    recordedVersionId?: string,
  ) => Promise<ServableVersion | undefined>,
): Promise<UpdateCheck> {
  // The platform travels with the lookup: the backend answers a delisted app per
  // platform, else an id search would only see the iOS build (see `lookupEntityFor`).
  const app = await lookupApp(
    task.software.bundleID,
    country,
    task.software.platform,
  );
  if (!app) return { status: "unknown" };

  if (needsVersionExchange(app)) {
    const newest = await lookupNewestServableVersion(
      account,
      app,
      task.software.externalVersionId,
    );
    if (!newest) return { status: "unknown" };
    const newer = isNewerServable(newest, task);
    if (newer === undefined) return { status: "unknown" };
    if (!newer) return { status: "current" };
    return {
      status: "newer",
      app,
      pin: newest.versionId,
      latestVersion: newest.displayVersion ?? newest.versionId,
      versions: newest.versions,
    };
  }

  if (!isNewerVersion(app.version, task.software.version)) {
    return { status: "current" };
  }
  return { status: "newer", app, latestVersion: app.version };
}

export default function DownloadList() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    tasks,
    loading,
    pauseDownload,
    resumeDownload,
    deleteDownload,
    hashToEmail,
  } = useDownloads();
  // A 「前往下载页」 hop names the package to point at — once. The history entry is
  // rewritten without it right away, so no reload or step back re-highlights anything.
  const hoppedTaskId =
    (location.state as { highlightTaskId?: string } | null)?.highlightTaskId ??
    null;
  const [highlightId, setHighlightId] = useState<string | null>(hoppedTaskId);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const addToast = useToastStore((s) => s.addToast);
  const { accounts } = useAccounts();
  const {
    startDownload,
    listVersionsWithLicense,
    lookupNewestServableVersion,
    toastDownloadError,
  } = useDownloadAction();
  const { versionMeta, pendingMeta, fillVersionsSilently } =
    useVersionMetadataMap();
  const previewEnabled = isDownloadPreviewEnabled(location.search);
  const displayTasks = previewEnabled ? previewDownloadTasks : tasks;

  const [checkingAll, setCheckingAll] = useState(false);
  const cancelCheckRef = useRef(false);
  const [checkProgress, setCheckProgress] = useState({
    current: 0,
    total: 0,
    appName: "",
  });
  const [deleteTarget, setDeleteTarget] = useState<DownloadTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The row whose update check is in flight, and what it found. */
  const [checkingUpdateId, setCheckingUpdateId] = useState<string | null>(null);
  const [updateTarget, setUpdateTarget] = useState<{
    task: DownloadTask;
    app: Software;
    /** The version the update message names — the newest one found. */
    latestVersion: string;
    versions: string[];
    selected: string;
  } | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    return () => {
      cancelCheckRef.current = true;
    };
  }, []);

  const filtered = displayTasks.filter((task) => matchesFilter(task, filter));

  // Take the hop off the entry that carried it; a reload or step back must find
  // the list unmarked.
  useEffect(() => {
    if (!hoppedTaskId) return;
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: null,
    });
  }, [hoppedTaskId, location.pathname, location.search, navigate]);

  // Scroll the target into view once rendered, then fade the highlight.
  useEffect(() => {
    if (!highlightId || (loading && displayTasks.length === 0)) return;
    if (!displayTasks.some((task) => task.id === highlightId)) return;
    const raf = window.requestAnimationFrame(() => {
      document
        .getElementById(`download-item-${highlightId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const timer = window.setTimeout(() => setHighlightId(null), 6000);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    // `displayTasks` is derived per render; its length stands in for it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, loading, displayTasks.length]);

  const sortedTasks = [...filtered].sort((a, b) => {
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  /** The pick's own name: the group has one, the raw statuses keep theirs. */
  const filterLabel = (pick: StatusFilter) =>
    pick === "active"
      ? t("downloads.filterActive")
      : t(`downloads.status.${pick}`);

  /** How many tasks a pick holds — `全部` included. */
  const statusCount = (pick: StatusFilter) =>
    displayTasks.filter((task) => matchesFilter(task, pick)).length;

  /** The filter's menu: `全部` first, then the four ways a task can sit. */
  const filterOptions = (
    ["all", "active", "paused", "completed", "failed"] as StatusFilter[]
  ).map((pick) => ({
    value: pick,
    label: t("downloads.statusWithCount", {
      status: filterLabel(pick),
      count: statusCount(pick),
    }),
  }));

  /** The account a task was downloaded with, as this list knows it. */
  const taskOwner = (task: DownloadTask) =>
    accounts.find((a) => a.email === hashToEmail[task.accountHash]);

  function handleDelete(id: string) {
    const task = displayTasks.find((item) => item.id === id);
    // A queued second click finds no task — nothing left to confirm.
    if (!task) return;
    if (isPreviewDownloadTask(task)) {
      showPreviewNotice();
      return;
    }

    // Native confirm() is not blocking in embedded browsers (Trae's returns true
    // immediately while still drawing the dialog), so deletion uses the in-app modal.
    setDeleteTarget(task);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      // Only announce success once the deletion actually completed.
      await deleteDownload(deleteTarget.id);
      const ctx = getAccountContext(taskOwner(deleteTarget), t);

      addToast(
        t("toast.msg", { appName: deleteTarget.software.name, ...ctx }),
        "success",
        t("toast.title.deleteSuccess"),
      );
      setDeleteTarget(null);
    } catch (err) {
      addToast(
        getErrorMessage(err, t("downloads.deleteFailed")),
        "error",
        t("downloads.package.delete"),
      );
    } finally {
      setDeleting(false);
    }
  }

  function showPreviewNotice() {
    addToast(
      t("downloads.preview.actionHint"),
      "info",
      t("downloads.preview.badge"),
    );
  }

  function handlePause(id: string) {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }
    pauseDownload(id);
  }

  function handleResume(id: string) {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }
    resumeDownload(id);
  }

  /**
   * Retries a failed download: same app, build and account. Apple is asked again
   * (also re-acquiring the license the failed attempt never used), not the handed
   * URL replayed. The replaced row is deleted: a failed task is terminal, so
   * keeping it would only leave it for the user to remove by hand.
   */
  async function handleRetry(id: string) {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }

    const task = tasks.find((item) => item.id === id);
    const account = task ? taskOwner(task) : undefined;
    if (!task || !account) return;

    try {
      await startDownload(
        account,
        task.software,
        task.software.externalVersionId || undefined,
      );
    } catch (err) {
      toastDownloadError(account, task.software, err);
      return;
    }

    try {
      await deleteDownload(id);
    } catch {
      // The retry itself succeeded; a stale row is harmless.
    }
  }

  /**
   * Asks for this app's latest version and offers to fetch it when newer. The
   * owning account must ask — the new build is redeemed against its license — so
   * the row only offers the check while that account is here. Same question as
   * `检查更新`, answered for one row.
   */
  async function handleCheckUpdate(id: string) {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }

    const task = displayTasks.find((item) => item.id === id);
    const account = task ? taskOwner(task) : undefined;
    if (!task || !account) return;

    setCheckingUpdateId(id);
    try {
      const country = storeIdToCountry(account.store) ?? "US";
      const found = await checkForUpdate(
        account,
        task,
        country,
        lookupNewestServableVersion,
      );

      // A check that could not be made is not an answer — report failure, not "already latest".
      if (found.status === "unknown") {
        addToast(t("downloads.package.checkUpdateFailed"), "error");
        return;
      }
      if (found.status === "current") {
        addToast(t("downloads.package.noUpdate"), "info");
        return;
      }

      // The storefront path opens on the exchange's list; the exchange path already carries it.
      const versions =
        found.versions ??
        (await listVersionsWithLicense(account, found.app)).versions;
      setUpdateTarget({
        task,
        app: found.app,
        latestVersion: found.latestVersion,
        versions,
        selected: found.pin ?? versions[0] ?? "",
      });
      // Shared cache first, then the missing labels filled silently.
      fillVersionsSilently(account, found.app, versions);
    } catch {
      addToast(t("downloads.package.checkUpdateFailed"), "error");
    } finally {
      setCheckingUpdateId(null);
    }
  }

  /**
   * Fetches the picked build and drops the row it replaces: the same app cannot
   * be held twice by one account, so the old package would only linger as a duplicate.
   */
  async function handleConfirmUpdate() {
    if (!updateTarget || updating) return;

    const { task, app, versions, selected } = updateTarget;
    const account = taskOwner(task);
    if (!account) return;

    setUpdating(true);
    try {
      const isLatest = versions.length > 0 && selected === versions[0];
      // A recalled record is reached only through a pin, so the picked build travels even
      // when newest: left unpinned, the request would resolve the pin a past download
      // recorded (the build on disk, not the one asked for). A storefront record stays unpinned.
      const pin = needsVersionExchange(app)
        ? selected
        : isLatest
          ? undefined
          : selected;
      // A recalled record's list can name the build this row holds; asking for it is
      // refused as a duplicate, so the row must stay — nothing replaced that package.
      const picksHeldBuild =
        selected !== "" && selected === (task.software.externalVersionId ?? "");
      await startDownload(account, app, pin || undefined);
      if (!picksHeldBuild) await deleteDownload(task.id);
      setUpdateTarget(null);
    } catch {
      addToast(t("downloads.package.updateFailed"), "error");
    } finally {
      setUpdating(false);
    }
  }

  function handleCancelCheck() {
    cancelCheckRef.current = true;
    setCheckingAll(false);
  }

  async function handleCheckAllUpdates() {
    if (previewEnabled) {
      showPreviewNotice();
      return;
    }

    cancelCheckRef.current = false;
    setCheckingAll(true);
    addToast(t("downloads.checkUpdatesStarted"), "info");
    let count = 0;
    const completedTasks = tasks.filter((t) => t.status === "completed");

    setCheckProgress({ current: 0, total: completedTasks.length, appName: "" });

    for (let i = 0; i < completedTasks.length; i++) {
      if (cancelCheckRef.current) break;

      const task = completedTasks[i];
      const account = taskOwner(task);

      setCheckProgress((prev) => ({ ...prev, appName: task.software.name }));

      if (!account) {
        setCheckProgress((prev) => ({ ...prev, current: i + 1 }));
        continue;
      }

      try {
        await delay(1500);
        if (cancelCheckRef.current) break;

        const country = storeIdToCountry(account.store) ?? "US";
        const found = await checkForUpdate(
          account,
          task,
          country,
          lookupNewestServableVersion,
        );

        // A row whose check could not be made is left as it is: starting a download
        // on a guess is not this loop's to do.
        if (found.status === "newer") {
          await startDownload(account, found.app, found.pin);
          await deleteDownload(task.id);
          count++;
        }
      } catch {
        // Continue with next item
      }

      setCheckProgress((prev) => ({ ...prev, current: i + 1 }));
    }

    if (!cancelCheckRef.current) {
      await delay(500);
      if (!cancelCheckRef.current) {
        setCheckingAll(false);
        addToast(t("downloads.checkUpdatesCompleted", { count }), "success");
      }
    }
  }

  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-7">
        <h1 className="min-w-0 text-[2rem] font-semibold leading-[1.12] tracking-[-0.035em] text-gray-900 sm:text-[2.125rem] dark:text-white">
          {t("downloads.title")}
        </h1>
        <button
          onClick={handleCheckAllUpdates}
          disabled={checkingAll}
          className="flex h-9 shrink-0 items-center justify-center rounded-full bg-blue-600 px-4 text-center text-[clamp(0.75rem,3.6vw,0.875rem)] font-semibold leading-tight text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 dark:bg-blue-600 dark:text-white dark:hover:bg-blue-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-600"
        >
          {checkingAll
            ? t("downloads.checkingUpdates")
            : t("downloads.checkUpdates")}
        </button>
      </div>

      <div className="mb-5 min-w-0 sm:max-w-xs">
        <Select
          value={filter}
          onChange={(next) => setFilter(next as StatusFilter)}
          options={filterOptions}
          ariaLabel={t("downloads.filter")}
          className="h-9 w-full min-w-0 rounded-full bg-white px-3 text-sm font-medium text-gray-700 ring-1 ring-black/5 transition-colors hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:ring-white/10 dark:hover:bg-gray-800"
        />
      </div>

      <div
        role="note"
        aria-label={t("downloads.warning")}
        title={t("downloads.warning")}
        className="mb-5 min-w-0 max-w-full overflow-hidden rounded-2xl bg-amber-50 px-2.5 py-3 text-center leading-relaxed text-amber-800 ring-1 ring-amber-200/70 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-800/50"
      >
        <span
          aria-hidden="true"
          className="block whitespace-nowrap text-[clamp(0.625rem,3.1vw,0.75rem)] xl:hidden"
        >
          {t("downloads.warningShort")}
        </span>
        <span
          aria-hidden="true"
          className="hidden whitespace-nowrap text-xs xl:block"
        >
          {t("downloads.warning")}
        </span>
      </div>

      {previewEnabled && (
        <div className="mb-5 flex min-w-0 items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full bg-blue-600 px-2 text-[10px] font-semibold uppercase tracking-wide text-white"
          >
            {t("downloads.preview.badge")}
          </span>
          <p className="min-w-0 leading-5">
            {t("downloads.preview.description")}
          </p>
        </div>
      )}

      {loading && displayTasks.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          {t("downloads.loading")}
        </div>
      ) : sortedTasks.length === 0 ? (
        <div className="my-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 px-6 py-16 text-center dark:border-gray-800 dark:bg-gray-900/30">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-white dark:bg-gray-900">
            <svg
              className="h-8 w-8 text-blue-600 dark:text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 text-center">
            {filter === "all"
              ? t("downloads.emptyAll")
              : t("downloads.emptyFilter", { status: filterLabel(filter) })}
          </h3>
          <p
            className="mb-6 max-w-full overflow-hidden text-center text-gray-500 dark:text-gray-400"
            aria-label={
              filter === "all"
                ? t("downloads.emptyAllDesc")
                : t("downloads.emptyFilterDesc")
            }
            title={
              filter === "all"
                ? t("downloads.emptyAllDesc")
                : t("downloads.emptyFilterDesc")
            }
          >
            {filter === "all" ? (
              <>
                <span
                  aria-hidden="true"
                  className="block whitespace-nowrap text-[clamp(0.625rem,3vw,0.875rem)] xl:hidden"
                >
                  {t("downloads.emptyAllDescShort")}
                </span>
                <span
                  aria-hidden="true"
                  className="hidden whitespace-nowrap text-sm xl:block"
                >
                  {t("downloads.emptyAllDesc")}
                </span>
              </>
            ) : (
              <span className="block whitespace-nowrap text-[clamp(0.625rem,3vw,0.875rem)]">
                {t("downloads.emptyFilterDesc")}
              </span>
            )}
          </p>
          {filter === "all" && (
            <Link
              to="/search"
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              {t("downloads.searchApps")}
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {sortedTasks.map((task) => {
            const accountEmail = hashToEmail[task.accountHash];
            const owner = taskOwner(task);
            return (
              <DownloadItem
                key={task.id}
                task={task}
                preview={previewEnabled}
                accountEmail={accountEmail}
                highlight={task.id === highlightId}
                onPause={handlePause}
                onResume={handleResume}
                onRetry={owner ? handleRetry : undefined}
                onCheckUpdate={owner ? handleCheckUpdate : undefined}
                checkingUpdate={checkingUpdateId === task.id}
                onDelete={handleDelete}
              />
            );
          })}
        </div>
      )}

      <Modal
        open={checkingAll && checkProgress.total > 0}
        onClose={handleCancelCheck}
        title={t("downloads.checkingUpdates")}
      >
        <div className="space-y-4">
          <div className="flex justify-center text-blue-600 dark:text-blue-400">
            <Spinner />
          </div>
          <div className="text-center">
            <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
              {checkProgress.appName
                ? `${t("downloads.checkingApp")}${checkProgress.appName}`
                : "..."}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono">
              {checkProgress.current} / {checkProgress.total}
            </p>
          </div>
          <ProgressBar
            label={t("downloads.checkingUpdates")}
            progress={
              checkProgress.total > 0
                ? (checkProgress.current / checkProgress.total) * 100
                : 0
            }
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
            {t("downloads.checkUpdatesDesc")}
          </p>
          <div className="flex justify-center">
            <button
              onClick={handleCancelCheck}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {t("settings.data.cancel")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={updateTarget !== null}
        onClose={() => setUpdateTarget(null)}
        title={t("downloads.package.updateAvailable")}
      >
        <div className="min-w-0 space-y-4">
          <p className="min-w-0 break-words text-sm text-gray-600 dark:text-gray-300">
            {t("downloads.package.updatePrompt", {
              version: updateTarget?.latestVersion,
            })}
          </p>
          {updateTarget && updateTarget.versions.length > 0 && (
            <div className="min-w-0">
              <label className="mb-1 block pl-3 text-sm font-medium text-gray-700 dark:text-gray-300">
                {t("downloads.package.selectVersion")}
              </label>
              <Select
                value={updateTarget.selected}
                onChange={(next) =>
                  setUpdateTarget((current) =>
                    current ? { ...current, selected: next } : current,
                  )
                }
                options={updateTarget.versions.map((version) => ({
                  value: version,
                  label: versionRowLabel(
                    version,
                    versionMeta[version],
                    pendingMeta[version],
                  ),
                  group: t("search.product.version"),
                }))}
                ariaLabel={t("downloads.package.selectVersion")}
                className="min-h-11 w-full min-w-0 max-w-full truncate rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
            </div>
          )}
          <div className="mt-6 grid min-w-0 grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setUpdateTarget(null)}
              disabled={updating}
              className="min-h-11 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {t("settings.data.cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirmUpdate}
              disabled={updating}
              className="min-h-11 min-w-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {updating && <Spinner />}
              {t("downloads.package.update")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t("downloads.deleteConfirm")}
      >
        <div className="min-w-0 space-y-4">
          <p className="min-w-0 break-words text-sm text-gray-600 dark:text-gray-300">
            {t("downloads.deletePrompt", {
              appName: deleteTarget?.software.name ?? "",
            })}
          </p>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="min-h-11 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {t("settings.data.cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              disabled={deleting}
              className="min-h-11 min-w-0 inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {deleting && <Spinner />}
              {t("downloads.package.delete")}
            </button>
          </div>
        </div>
      </Modal>
    </PageContainer>
  );
}
