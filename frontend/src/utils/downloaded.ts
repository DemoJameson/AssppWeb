import type { DownloadTask, Platform, Software } from "../types";

/**
 * Whether the server holds a package for this task — what "已下载" means
 * everywhere in the UI. A task that finished but lost its file (the backend
 * reports that through `hasFile`) does not count: there is nothing to open,
 * and asking for the build again is the only way back to one.
 */
export function holdsPackage(task: DownloadTask): boolean {
  return task.status === "completed" && task.hasFile !== false;
}

/**
 * Whether a task stands between the user and a second download of the same
 * build: one that already holds the package, or one still working towards it.
 * Only a failure leaves the way open — retrying is all that can fix it.
 */
export function blocksRedownload(task: DownloadTask): boolean {
  return task.status !== "failed";
}

/**
 * The tasks that speak for one app on one platform *under one account*. A
 * package belongs to the account that fetched it — it carries that account's
 * license and its signature — so another account's copy is not this account's:
 * it neither blocks this account from downloading the same build nor answers as
 * something this account holds. `accountHash` is the download list's own key
 * (`utils/account.accountHash`); a hash that names no account (an account whose
 * digest is not known yet) matches nothing.
 *
 * A package compiled before the platform was recorded carries none and so
 * cannot contradict the pick — it stays a candidate.
 */
export function tasksForApp(
  tasks: DownloadTask[],
  appId: number,
  platform: Platform | undefined,
  accountHash: string,
): DownloadTask[] {
  return tasks.filter((task) => {
    if (task.accountHash !== accountHash) return false;
    if (task.software.id !== appId) return false;
    const recorded = task.software.platform;
    return !platform || !recorded || recorded === platform;
  });
}

export interface DownloadedBuilds {
  /** External version ids of the builds the server holds. */
  ids: Set<string>;
  /**
   * Version numbers of the builds the server holds *and* cannot name by id —
   * packages compiled before the external version id was recorded.
   */
  versions: Set<string>;
}

/**
 * What one account already holds of one app on one platform: the builds a
 * version list may mark as downloaded, and a download may refuse to repeat.
 */
export function downloadedBuilds(
  tasks: DownloadTask[],
  appId: number,
  platform: Platform | undefined,
  accountHash: string,
): DownloadedBuilds {
  const ids = new Set<string>();
  const versions = new Set<string>();
  for (const task of tasksForApp(tasks, appId, platform, accountHash)) {
    if (!holdsPackage(task)) continue;
    const id = task.software.externalVersionId?.trim();
    if (id) {
      ids.add(id);
      continue;
    }
    const version = task.software.version?.trim();
    if (version) versions.add(version);
  }
  return { ids, versions };
}

/**
 * Whether a build of a version list is one the account already holds. The
 * external id decides it; the version number is the fallback for packages that
 * predate the id, and two builds can share a number — so it only ever speaks
 * for a package that has no id of its own.
 */
export function isBuildDownloaded(
  builds: DownloadedBuilds,
  versionId: string,
  displayVersion?: string,
): boolean {
  if (builds.ids.has(versionId)) return true;
  return !!displayVersion && builds.versions.has(displayVersion);
}

/**
 * The package the account holds that *is* the build a version list named — the
 * task its facts can be read from: the compiled package's own version, size,
 * minimum OS and date, which is what a detail view describes when that build is
 * the one on screen. Another account's package of the same build is not it.
 *
 * Identity follows {@link isBuildDownloaded}: the external id decides it, and a
 * version number only ever speaks for a package that has no id of its own.
 */
export function heldBuildFor(
  tasks: DownloadTask[],
  appId: number,
  platform: Platform | undefined,
  versionId: string,
  displayVersion: string | undefined,
  accountHash: string,
): DownloadTask | undefined {
  if (!versionId && !displayVersion) return undefined;
  return tasksForApp(tasks, appId, platform, accountHash).find((task) => {
    if (!holdsPackage(task)) return false;
    const id = task.software.externalVersionId?.trim();
    if (id) return id === versionId;
    return !!displayVersion && task.software.version === displayVersion;
  });
}

/**
 * The task of this account that already covers the build a download would ask
 * for — the one that makes adding it a duplicate, and that the caller should
 * point at instead. Undefined when the account does not hold the build, or when
 * neither the pin nor the record can name the build the request would land on
 * (Apple picks it then, so nothing is knowingly repeated).
 *
 * The account is what "already downloaded" is asked of: the same build under
 * another account is a different package, and downloading it there is the point.
 *
 * A pinned build is identified by its external id alone: the record's own
 * version number belongs to whatever build the catalogue named, not to the one
 * the user picked further down the list.
 */
export function findDuplicateDownload(
  tasks: DownloadTask[],
  app: Software,
  versionId: string | undefined,
  accountHash: string,
): DownloadTask | undefined {
  const covering = tasksForApp(
    tasks,
    app.id,
    app.platform,
    accountHash,
  ).filter(blocksRedownload);
  if (versionId) {
    return covering.find(
      (task) => task.software.externalVersionId === versionId,
    );
  }
  // Nothing pinned: Apple decides which build answers, so the version number
  // the record carries is the only identity the request has.
  const version = app.version?.trim();
  if (!version) return undefined;
  return covering.find((task) => task.software.version === version);
}
