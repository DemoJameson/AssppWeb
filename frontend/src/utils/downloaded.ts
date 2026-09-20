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
 * The tasks that speak for one app on one platform. A package compiled before
 * the platform was recorded carries none and so cannot contradict the pick —
 * it stays a candidate.
 */
export function tasksForApp(
  tasks: DownloadTask[],
  appId: number,
  platform?: Platform,
): DownloadTask[] {
  return tasks.filter((task) => {
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
 * What the server already holds of one app on one platform: the builds a
 * version list may mark as downloaded, and a download may refuse to repeat.
 */
export function downloadedBuilds(
  tasks: DownloadTask[],
  appId: number,
  platform?: Platform,
): DownloadedBuilds {
  const ids = new Set<string>();
  const versions = new Set<string>();
  for (const task of tasksForApp(tasks, appId, platform)) {
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
 * Whether a build of a version list is one the server already holds. The
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
 * The held package that *is* the build a version list named — the task its
 * facts can be read from: the compiled package's own version, size, minimum OS
 * and date, which is what a detail view describes when that build is the one on
 * screen.
 *
 * Identity follows {@link isBuildDownloaded}: the external id decides it, and a
 * version number only ever speaks for a package that has no id of its own.
 */
export function heldBuildFor(
  tasks: DownloadTask[],
  appId: number,
  platform: Platform | undefined,
  versionId: string,
  displayVersion?: string,
): DownloadTask | undefined {
  if (!versionId && !displayVersion) return undefined;
  return tasksForApp(tasks, appId, platform).find((task) => {
    if (!holdsPackage(task)) return false;
    const id = task.software.externalVersionId?.trim();
    if (id) return id === versionId;
    return !!displayVersion && task.software.version === displayVersion;
  });
}

/**
 * The task that already covers the build a download would ask for — the one
 * that makes adding it a duplicate, and that the caller should point at
 * instead. Undefined when the build is not covered, or when neither the pin
 * nor the record can name the build the request would land on (Apple picks it
 * then, so nothing is knowingly repeated).
 *
 * A pinned build is identified by its external id alone: the record's own
 * version number belongs to whatever build the catalogue named, not to the one
 * the user picked further down the list.
 */
export function findDuplicateDownload(
  tasks: DownloadTask[],
  app: Software,
  versionId?: string,
): DownloadTask | undefined {
  const covering = tasksForApp(tasks, app.id, app.platform).filter(
    blocksRedownload,
  );
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
