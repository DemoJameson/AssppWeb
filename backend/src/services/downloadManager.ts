import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { config, DOWNLOAD_TIMEOUT_MS } from "../config.js";
import {
  inject,
  extractPackageIcon,
  type PackageMetadata,
  type PackageIcon,
} from "./sinfInjector.js";
import { ChunkedDownloader } from "./chunkedDownloader.js";
import type { DownloadTask, Software, Sinf } from "../types/index.js";

const tasks = new Map<string, DownloadTask>();
const abortControllers = new Map<string, AbortController>();
const chunkDownloaders = new Map<string, ChunkedDownloader>();
const progressListeners = new Map<string, Set<(task: DownloadTask) => void>>();

const PACKAGES_DIR = path.join(config.dataDir, "packages");
const TASKS_FILE = path.join(config.dataDir, "tasks.json");
// Legacy file from old code — cleaned up on startup
const LEGACY_DOWNLOADS_FILE = path.join(config.dataDir, "downloads.json");

// --- Security: path segment validation ---
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/** Validate and sanitize a path segment. Rejects traversal, replaces unsafe chars. */
function safePathSegment(value: string, label: string): string {
  if (!value || value === "." || value === "..") {
    throw new Error(`Invalid ${label}`);
  }
  if (SAFE_SEGMENT_RE.test(value)) return value;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`Invalid ${label}`);
  }
  return cleaned;
}

/**
 * Directory segment identifying the app of a task: its bundle id when known,
 * otherwise the numeric app id. ipatool keys a download off the app id and
 * simply omits the fields it does not know, so a download started from a bare
 * app id still gets a valid, collision-free layout.
 */
export function appPathSegment(software: Software): string {
  return safePathSegment(
    software.bundleID || String(software.id),
    "bundleID",
  );
}

/**
 * Fills in what a task could not know up front from what the compiled package
 * declares. A value the storefront reported always wins, so a download created
 * from search results is left untouched.
 *
 * The manual download page labels an app it could not look up as `App <id>`
 * (see `placeholderSoftware` in the frontend's ManualDownload page); that label
 * counts as "no name yet" so the package can supply the real one.
 */
export function applyPackageMetadata(
  software: Software,
  metadata: PackageMetadata,
): void {
  if (metadata.name && (!software.name || software.name === `App ${software.id}`)) {
    software.name = metadata.name;
  }

  software.bundleID = fillMissing(software.bundleID, metadata.bundleID);
  software.version = fillMissing(software.version, metadata.version);
  software.artistName = fillMissing(software.artistName, metadata.artistName);
  software.minimumOsVersion = fillMissing(
    software.minimumOsVersion,
    metadata.minimumOsVersion,
  );
  software.primaryGenreName = fillMissing(
    software.primaryGenreName,
    metadata.primaryGenreName,
  );
  software.releaseDate = fillMissing(software.releaseDate, metadata.releaseDate);
}

function fillMissing(current: string, fallback?: string): string {
  return current || fallback || "";
}

// --- App icon extracted from the compiled package ---

/**
 * The icon is parked beside the IPA under this name, so its location is a
 * function of the task's own file path and needs no extra bookkeeping.
 */
const ICON_BASENAME = "icon";
const ICON_EXTENSIONS = ["png", "jpg"] as const;

/**
 * The icon a task's package carried, or null when it had none — a package
 * without a usable image simply falls back to whatever the UI shows instead.
 */
export function iconPathFor(task: DownloadTask): string | null {
  if (!task.filePath) return null;

  const dir = path.dirname(task.filePath);
  for (const extension of ICON_EXTENSIONS) {
    const candidate = path.join(dir, `${ICON_BASENAME}.${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Apple ships PNGs; JPEG is the only other shape a bundle may carry. */
function iconExtensionFor(data: Buffer): (typeof ICON_EXTENSIONS)[number] {
  return data[0] === 0xff && data[1] === 0xd8 ? "jpg" : "png";
}

function writeTaskIcon(task: DownloadTask, icon?: PackageIcon): void {
  if (!icon || !task.filePath) return;

  const dir = path.dirname(task.filePath);
  const extension = iconExtensionFor(icon.data);
  const target = path.join(dir, `${ICON_BASENAME}.${extension}`);

  try {
    // An icon left under the other extension would still be found, so clear it.
    for (const other of ICON_EXTENSIONS) {
      if (other === extension) continue;
      const stale = path.join(dir, `${ICON_BASENAME}.${other}`);
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    }

    fs.writeFileSync(target, icon.data);
  } catch (err) {
    // A missing icon is cosmetic; it must not fail a download that compiled.
    console.warn(
      `[downloadManager] Could not store the app icon: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// --- Security: download URL allowlist ---
const ALLOWED_DOWNLOAD_HOSTS_RE = /\.apple\.com$/i;

export function validateDownloadURL(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid download URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Download URL must use HTTPS");
  }

  if (!ALLOWED_DOWNLOAD_HOSTS_RE.test(parsed.hostname)) {
    throw new Error("Download URL must be from an Apple domain (*.apple.com)");
  }

  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) ||
    parsed.hostname.startsWith("[")
  ) {
    throw new Error("Download URL must not use IP addresses");
  }
}

// --- Security: sanitize task for API responses ---
export function sanitizeTaskForResponse(
  task: DownloadTask,
): Omit<
  DownloadTask,
  "downloadURL" | "sinfs" | "iTunesMetadata" | "filePath"
> & { hasFile?: boolean; hasIcon?: boolean } {
  const { downloadURL, sinfs, iTunesMetadata, filePath, ...safe } = task;
  return {
    ...safe,
    hasFile: !!filePath && fs.existsSync(filePath),
    hasIcon: Boolean(iconPathFor(task)),
  };
}

// --- Persistence: save only completed task metadata (no secrets) ---
function persistTasks() {
  const completed = Array.from(tasks.values())
    .filter((t) => t.status === "completed" && t.filePath)
    .map((t) => ({
      id: t.id,
      software: t.software,
      accountHash: t.accountHash,
      downloadURL: "",
      sinfs: [],
      status: t.status,
      progress: t.progress,
      speed: t.speed,
      filePath: t.filePath,
      createdAt: t.createdAt,
    }));
  fs.writeFileSync(TASKS_FILE, JSON.stringify(completed, null, 2));
}

// Auto-cleanup: delete completed files older than configured days
export function runTimeCleanup() {
  const { autoCleanupDays } = config;
  if (autoCleanupDays <= 0) return;
  const cutoff = Date.now() - autoCleanupDays * 24 * 60 * 60 * 1000;

  // Collect IDs first to avoid mutating the map during iteration
  const expiredIds: string[] = [];
  for (const task of tasks.values()) {
    if (
      task.status === "completed" &&
      task.filePath &&
      fs.existsSync(task.filePath)
    ) {
      try {
        const stat = fs.statSync(task.filePath);
        if (stat.mtimeMs < cutoff) {
          expiredIds.push(task.id);
        }
      } catch {
        // File inaccessible — skip
      }
    }
  }

  for (const id of expiredIds) {
    console.log(`[Cleanup] Deleting expired task: ${id}`);
    deleteTask(id);
  }
}

// Auto-cleanup: evict oldest completed files when total size exceeds limit
export function runSpaceCleanup() {
  const { autoCleanupMaxMB } = config;
  if (autoCleanupMaxMB <= 0) return;
  const maxBytes = autoCleanupMaxMB * 1024 * 1024;

  let totalBytes = 0;
  const fileTasks: { id: string; size: number; mtimeMs: number }[] = [];

  for (const task of tasks.values()) {
    if (
      task.status === "completed" &&
      task.filePath &&
      fs.existsSync(task.filePath)
    ) {
      try {
        const stat = fs.statSync(task.filePath);
        totalBytes += stat.size;
        fileTasks.push({ id: task.id, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // File inaccessible — skip
      }
    }
  }

  if (totalBytes <= maxBytes) return;

  fileTasks.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const ft of fileTasks) {
    console.log(`[Cleanup] Space limit exceeded, deleting task: ${ft.id}`);
    deleteTask(ft.id);
    totalBytes -= ft.size;
    if (totalBytes <= maxBytes) break;
  }
}

// Schedule daily time-based cleanup at midnight (self-correcting to avoid drift)
function scheduleDailyCleanup() {
  function msUntilMidnight(): number {
    const now = new Date();
    const next = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
    );
    return next.getTime() - now.getTime();
  }

  function tick() {
    runTimeCleanup();
    setTimeout(tick, msUntilMidnight());
  }

  setTimeout(tick, msUntilMidnight());
}

function initOnStartup() {
  // Remove legacy downloads.json from old code
  if (fs.existsSync(LEGACY_DOWNLOADS_FILE)) {
    fs.unlinkSync(LEGACY_DOWNLOADS_FILE);
  }

  // Ensure packages dir exists
  fs.mkdirSync(PACKAGES_DIR, { recursive: true });

  // Load completed tasks from previous run
  if (fs.existsSync(TASKS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
      if (Array.isArray(data)) {
        for (const item of data) {
          // Only restore completed tasks whose IPA file still exists
          if (
            item.id &&
            item.status === "completed" &&
            item.filePath &&
            fs.existsSync(item.filePath)
          ) {
            const task: DownloadTask = {
              id: item.id,
              software: item.software,
              accountHash: item.accountHash,
              downloadURL: "",
              sinfs: [],
              status: "completed",
              progress: 100,
              speed: "0 B/s",
              filePath: item.filePath,
              createdAt: item.createdAt,
            };
            tasks.set(task.id, task);
          }
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  // Clean up orphaned IPA files (files without a task)
  cleanOrphanedPackages();

  // Recover or repair icons for packages compiled before icons were handled.
  // Deliberately not awaited: it is file work over packages that may be hundreds
  // of megabytes, and it must not hold up the server.
  void repairTaskIcons().catch(() => {});

  // Run time-based cleanup once on startup, then schedule daily
  runTimeCleanup();
  scheduleDailyCleanup();
}

/**
 * Makes the stored icon of every finished package match what that package
 * actually contains, under the rules the extractor applies today.
 *
 * Re-deriving rather than only filling gaps is deliberate: the stored file is a
 * cached answer, so a rule fix has to reach packages that are already on disk —
 * and a package with no icon of its own has any stale one removed, because a
 * wrong icon is worse than none when the storefront's is available instead. The
 * alternative to all of this is asking the user to download the app again.
 *
 * Runs in the background: it reads archives that can be hundreds of megabytes,
 * and it must not hold up the server. The frontend picks the result up as soon
 * as it next lists the downloads, since `hasIcon` is answered from the file
 * system on every request.
 */
async function repairTaskIcons(): Promise<void> {
  const finished = Array.from(tasks.values()).filter(
    (task) => task.status === "completed" && task.filePath,
  );
  let changed = 0;

  for (const task of finished) {
    const filePath = task.filePath;
    if (!filePath || !fs.existsSync(filePath)) continue;

    let icon: PackageIcon | undefined;
    try {
      icon = await extractPackageIcon(filePath);
    } catch (err) {
      console.warn(
        `[downloadManager] Could not read the icon of ${task.id}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }

    const stored = iconPathFor(task);

    if (icon) {
      if (stored && iconsMatch(stored, icon.data)) continue;
      writeTaskIcon(task, icon);
      changed++;
      continue;
    }

    if (stored) {
      fs.unlinkSync(stored);
      changed++;
    }
  }

  if (changed > 0) {
    console.log(
      `[downloadManager] Refreshed the icon of ${changed} finished package(s)`,
    );
  }
}

function iconsMatch(iconPath: string, data: Buffer): boolean {
  try {
    return fs.readFileSync(iconPath).equals(data);
  } catch {
    return false;
  }
}

function cleanOrphanedPackages() {
  const knownPaths = new Set<string>();
  for (const task of tasks.values()) {
    if (task.filePath) {
      knownPaths.add(path.resolve(task.filePath));
    }
    // The icon lives beside the IPA but is not the task's file, so it has to be
    // listed explicitly or the sweep below would delete it as an orphan.
    const iconPath = iconPathFor(task);
    if (iconPath) knownPaths.add(path.resolve(iconPath));
  }

  const packagesBase = path.resolve(PACKAGES_DIR);

  function walkAndClean(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndClean(fullPath);
        // Remove empty directories
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
        }
      } else if (entry.isFile() && !knownPaths.has(path.resolve(fullPath))) {
        // Orphaned file or leftover .part temp file — remove
        fs.unlinkSync(fullPath);
      }
    }
  }

  walkAndClean(packagesBase);
}

// Initialize on startup
initOnStartup();

function notifyProgress(task: DownloadTask) {
  const listeners = progressListeners.get(task.id);
  if (listeners) {
    for (const listener of listeners) {
      listener(task);
    }
  }
}

export function addProgressListener(
  taskId: string,
  listener: (task: DownloadTask) => void,
) {
  let listeners = progressListeners.get(taskId);
  if (!listeners) {
    listeners = new Set();
    progressListeners.set(taskId, listeners);
  }
  listeners.add(listener);
}

export function removeProgressListener(
  taskId: string,
  listener: (task: DownloadTask) => void,
) {
  const listeners = progressListeners.get(taskId);
  if (listeners) {
    listeners.delete(listener);
    if (listeners.size === 0) {
      progressListeners.delete(taskId);
    }
  }
}

export function getAllTasks(): DownloadTask[] {
  return Array.from(tasks.values());
}

export function getTask(id: string): DownloadTask | undefined {
  return tasks.get(id);
}

export function deleteTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;

  // Abort if downloading
  const controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
    abortControllers.delete(id);
  }
  const downloader = chunkDownloaders.get(id);
  if (downloader) {
    downloader.abort();
    chunkDownloaders.delete(id);
  }

  // Remove file if exists, with path safety check
  if (task.filePath) {
    const resolved = path.resolve(task.filePath);
    const packagesBase = path.resolve(PACKAGES_DIR);
    if (
      resolved.startsWith(packagesBase + path.sep) &&
      fs.existsSync(resolved)
    ) {
      fs.unlinkSync(resolved);

      const iconPath = iconPathFor(task);
      if (iconPath) fs.unlinkSync(iconPath);

      // Clean up empty parent directories
      let dir = path.dirname(resolved);
      while (dir !== packagesBase && dir.startsWith(packagesBase)) {
        const contents = fs.readdirSync(dir);
        if (contents.length === 0) {
          fs.rmdirSync(dir);
          dir = path.dirname(dir);
        } else {
          break;
        }
      }
    }
  }

  tasks.delete(id);
  progressListeners.delete(id);
  persistTasks();
  return true;
}

export function pauseTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "downloading") return false;

  const controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
    abortControllers.delete(id);
  }
  const downloader = chunkDownloaders.get(id);
  if (downloader) {
    downloader.abort();
    chunkDownloaders.delete(id);
  }

  task.status = "paused";
  notifyProgress(task);
  return true;
}

export function resumeTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "paused") return false;

  startDownload(task);
  return true;
}

export function createTask(
  software: Software,
  accountHash: string,
  downloadURL: string,
  sinfs: Sinf[],
  iTunesMetadata?: string,
): DownloadTask {
  // Validate download URL
  validateDownloadURL(downloadURL);

  // Validate path segments. The app id is the one field a download cannot do
  // without: it is what Apple is asked for, and it names the directory when the
  // bundle id is unknown.
  if (!Number.isInteger(software.id) || software.id <= 0) {
    throw new Error("Invalid app id");
  }
  safePathSegment(accountHash, "accountHash");
  appPathSegment(software);
  safePathSegment(software.version, "version");

  const task: DownloadTask = {
    id: uuidv4(),
    software,
    accountHash,
    downloadURL,
    sinfs,
    iTunesMetadata,
    status: "pending",
    progress: 0,
    speed: "0 B/s",
    createdAt: new Date().toISOString(),
  };

  tasks.set(task.id, task);
  startDownload(task);
  return task;
}

async function startDownload(task: DownloadTask) {
  // Pre-download cleanup: expire old files + enforce space limit
  runTimeCleanup();
  runSpaceCleanup();

  const controller = new AbortController();
  abortControllers.set(task.id, controller);

  // Set a global timeout for the entire download
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  task.status = "downloading";
  task.progress = 0;
  task.speed = "0 B/s";
  task.error = undefined;
  notifyProgress(task);

  // Sanitize path segments
  const safeAccountHash = safePathSegment(task.accountHash, "accountHash");
  const safeAppSegment = appPathSegment(task.software);
  const safeVersion = safePathSegment(task.software.version, "version");

  const dir = path.join(
    PACKAGES_DIR,
    safeAccountHash,
    safeAppSegment,
    safeVersion,
  );

  // Verify the resolved path is within PACKAGES_DIR
  const resolvedDir = path.resolve(dir);
  const packagesBase = path.resolve(PACKAGES_DIR);
  if (!resolvedDir.startsWith(packagesBase + path.sep)) {
    task.status = "failed";
    task.error = "Invalid path";
    clearTimeout(timeout);
    notifyProgress(task);
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${task.id}.ipa`);
  task.filePath = filePath;

  try {
    // Re-validate download URL before fetching
    validateDownloadURL(task.downloadURL);

    const downloader = new ChunkedDownloader(task.downloadURL, filePath, {
      onProgress: (info) => {
        task.speed = info.speed;
        if (info.total > 0) {
          task.progress = Math.round((info.downloaded / info.total) * 100);
        }
        notifyProgress(task);
      },
    });
    chunkDownloaders.set(task.id, downloader);

    await downloader.download(controller.signal);

    chunkDownloaders.delete(task.id);
    abortControllers.delete(task.id);
    clearTimeout(timeout);

    // Inject sinfs
    if (task.sinfs.length > 0) {
      task.status = "injecting";
      task.progress = 100;
      notifyProgress(task);

      const { metadata, icon } = await inject(
        task.sinfs,
        filePath,
        task.iTunesMetadata,
      );

      // A download started from a bare app id knows almost nothing about the
      // app it asked for. The package does, so fill in whatever is still
      // missing before the task is persisted: every view then reports the real
      // values instead of the placeholder the request carried.
      applyPackageMetadata(task.software, metadata);
      writeTaskIcon(task, icon);
      if (!task.software.fileSizeBytes) {
        task.software.fileSizeBytes = String(fs.statSync(filePath).size);
      }
    }

    task.status = "completed";
    task.progress = 100;

    // Strip sensitive data after successful compile
    task.downloadURL = "";
    task.sinfs = [];
    task.iTunesMetadata = undefined;

    // Persist completed task metadata (no secrets)
    persistTasks();
    notifyProgress(task);
  } catch (err) {
    chunkDownloaders.delete(task.id);
    abortControllers.delete(task.id);
    clearTimeout(timeout);

    if (err instanceof Error && err.name === "AbortError") {
      // Status may have been changed to "paused" externally by pauseTask()
      if ((task.status as string) === "paused") return;
      task.status = "failed";
      task.error = "Download timed out";
      notifyProgress(task);
      return;
    }

    task.status = "failed";
    console.error(
      `Download ${task.id} failed:`,
      err instanceof Error ? err.message : err,
    );
    task.error = "Download failed";
    notifyProgress(task);
  }
}
