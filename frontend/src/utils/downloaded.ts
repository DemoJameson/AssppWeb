import type { DownloadTask, Platform, Software } from "../types";

/**
 * Whether the server holds a package for this task — what "已下载" means in the
 * UI. A task that lost its file (reported via `hasFile`) does not count.
 */
export function holdsPackage(task: DownloadTask): boolean {
  return task.status === "completed" && task.hasFile !== false;
}

/** Whether a task blocks a second download of the same build; only a failure leaves the way open. */
export function blocksRedownload(task: DownloadTask): boolean {
  return task.status !== "failed";
}

/** The tasks that speak for one app on one platform *under one account*: a package carries
 * the account's license and signature, so another account's copy neither blocks nor answers
 * as this account's. `accountHash` is the download list's key (`utils/account.accountHash`);
 * a hash naming no account matches nothing. A package with no platform recorded can't
 * contradict the pick, so it stays a candidate.
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
   * Version numbers of held builds that cannot be named by id — packages
   * compiled before the external version id was recorded.
   */
  versions: Set<string>;
}

/** What one account holds of one app on one platform: the builds a version list marks downloaded, and that a download refuses to repeat. */
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
 * Whether the account already holds a build. The external id decides; the
 * version number is only a fallback for packages that predate the id, and two
 * builds can share a number.
 */
export function isBuildDownloaded(
  builds: DownloadedBuilds,
  versionId: string,
  displayVersion?: string,
): boolean {
  if (builds.ids.has(versionId)) return true;
  return !!displayVersion && builds.versions.has(displayVersion);
}

/** The package the account holds that *is* the named build — its facts (compiled version,
 * size, minimum OS, date) are what a detail view describes. Identity follows
 * {@link isBuildDownloaded}: the external id decides; a version number speaks only for a
 * package with no id of its own.
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

/** The task of this account that already covers the build a download would ask for — the
 * duplicate the caller should point at instead. Undefined when the account does not hold
 * the build, or when neither the pin nor the record names the build the request would land
 * on (Apple picks it then). A pinned build is identified by its external id alone.
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
