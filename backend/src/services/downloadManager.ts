import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { config, DOWNLOAD_TIMEOUT_MS } from "../config.js";
import {
  inject,
  readPackageInfo,
  type PackageMetadata,
  type PackageIcon,
} from "./sinfInjector.js";
import {
  assertMacOSPackage,
  validatePackagePlatform,
  PackagePlatformError,
  readArchiveMagic,
  IPA_SERVED_TO_MACOS,
} from "./packagePlatform.js";
import { decryptMacOSPackage } from "./macDecrypt.js";
import {
  initVersionMetadataCache,
  seedVersionMetadata,
} from "./versionMetadataCache.js";
import { initVersionPinStore, recordVersionPin } from "./versionPinStore.js";
import {
  initPackageAppStore,
  rememberPackageApp,
} from "./packageAppStore.js";
import { ChunkedDownloader, removePartFiles } from "./chunkedDownloader.js";
import { getDb } from "./db.js";
import type { DownloadTask, Platform, Software, Sinf } from "../types/index.js";

const tasks = new Map<string, DownloadTask>();
const abortControllers = new Map<string, AbortController>();
const chunkDownloaders = new Map<string, ChunkedDownloader>();
const progressListeners = new Map<string, Set<(task: DownloadTask) => void>>();

const PACKAGES_DIR = path.join(config.dataDir, "packages");
// Legacy file from old code — cleaned up on startup
const LEGACY_DOWNLOADS_FILE = path.join(config.dataDir, "downloads.json");

// --- Security: path segment validation ---
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/** Validate and sanitize a path segment. Rejects traversal, replaces unsafe chars. */
function safePathSegment(value: string, label: string): string {
  // Callers pass unchecked request-body fields; a non-string would reach
  // `path.join` and throw. Refuse non-strings up front.
  if (typeof value !== "string" || !value || value === "." || value === "..") {
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
 * Directory segment for a task's app: its bundle id, else the numeric app id,
 * so a download started from a bare app id still gets a collision-free layout.
 */
export function appPathSegment(software: Software): string {
  return safePathSegment(
    software.bundleID || String(software.id),
    "bundleID",
  );
}

/**
 * Fills in what a task could not know up front from the compiled package's own
 * declarations. A value the storefront reported always wins.
 */
/** Fields of `Software` that a package can supply when the request did not. */
type FillableField =
  | "bundleID"
  | "version"
  | "artistName"
  | "minimumOsVersion"
  | "primaryGenreName"
  | "releaseDate"
  | "artworkUrl"
  | "externalVersionId";

/**
 * @returns whether anything was filled in.
 */
export function applyPackageMetadata(
  software: Software,
  metadata: PackageMetadata,
): boolean {
  let changed = false;

  // `App <id>` (see the frontend's `bareSoftwareById`) counts as "no name yet".
  if (
    metadata.name &&
    (!software.name || software.name === `App ${software.id}`)
  ) {
    software.name = metadata.name;
    changed = true;
  }

  const fill = (field: FillableField, value?: string) => {
    if (fillIn(software, field, value)) changed = true;
  };

  fill("bundleID", metadata.bundleID);
  fill("version", metadata.version);
  fill("artistName", metadata.artistName);
  fill("primaryGenreName", metadata.primaryGenreName);
  fill("releaseDate", metadata.releaseDate);
  fill("artworkUrl", metadata.artworkURL);
  fill("externalVersionId", metadata.externalVersionId);

  // CFBundleSupportedPlatforms is the authority over the requested platform: an
  // app searched as tvOS may have served its iOS build, and the package knows.
  const platformChanged =
    !!metadata.platform && software.platform !== metadata.platform;
  if (platformChanged) {
    software.platform = metadata.platform;
    changed = true;
  }

  // A minimum OS version belongs to the platform that declared it, so a record
  // corrected to another platform cannot keep the old value. The package's own
  // value replaces it; unknown when the package declared none.
  if (platformChanged) {
    if (software.minimumOsVersion !== (metadata.minimumOsVersion ?? "")) {
      changed = true;
    }
    software.minimumOsVersion = metadata.minimumOsVersion ?? "";
  } else {
    fill("minimumOsVersion", metadata.minimumOsVersion);
  }

  return changed;
}

function fillIn(
  software: Software,
  field: FillableField,
  value?: string,
): boolean {
  if (!value || software[field]) return false;
  software[field] = value;
  return true;
}

// --- App icon extracted from the compiled package ---

/**
 * The icon sits beside the IPA under this name, so its location derives from the
 * task's file path and needs no extra bookkeeping.
 */
const ICON_BASENAME = "icon";
const ICON_EXTENSIONS = ["png", "jpg"] as const;

/** The icon a task's package carried, or null when it had none. */
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
    task.hasIcon = true;
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

/**
 * Refuses a macOS package (.pkg, a xar container with no sinfs) for a non-macOS
 * task. A guessed version pin (see the frontend's `versionFinder`) can hand a
 * tvOS task a Mac package, which would only fail after the whole download. The
 * other direction — an IPA for a macOS task — is caught by `assertMacOSPackage`.
 */
export function assertPackageMatchesPlatform(
  url: string,
  platform?: Platform,
): void {
  if (platform === "macos") return;
  if (!new URL(url).pathname.toLowerCase().endsWith(".pkg")) return;

  throw new Error(
    `A ${platform ?? "non-macOS"} download was offered a macOS package (.pkg)`,
  );
}

/**
 * Turns a macOS task's downloaded bytes into an installable package. Apple
 * serves it encrypted, and StoreAgent's decryption takes minutes, so the task
 * runs under `injecting` rather than sitting at the transfer's 100%.
 */
async function decryptTaskPackage(
  task: DownloadTask,
  filePath: string,
  signal: AbortSignal,
): Promise<void> {
  const magic = await readArchiveMagic(filePath);

  if (magic === null) {
    throw new PackagePlatformError("macOS package could not be read");
  }

  // An IPA has nothing to decrypt; refused with the archive check's words.
  if (magic.startsWith("PK")) {
    throw new PackagePlatformError(IPA_SERVED_TO_MACOS);
  }

  // A pause/delete that landed as the transfer ended already set the task's
  // status; overwriting it with `injecting` would strand the row (pause only
  // takes `downloading`, resume only `paused`). Unwinds as a stale attempt.
  if (signal.aborted) {
    const aborted = new Error("Aborted");
    aborted.name = "AbortError";
    throw aborted;
  }

  // Already a package (served unencrypted); decrypting it would corrupt it.
  if (magic === "xar!") return;

  if (!task.dpInfo || !task.hardwareId) {
    throw new PackagePlatformError(
      "the macOS download cannot be decrypted: it carries no dpInfo",
    );
  }

  task.status = "injecting";
  task.progress = 0;
  notifyProgress(task);

  await decryptMacOSPackage({
    filePath,
    dpInfo: task.dpInfo,
    hardwareId: task.hardwareId,
    signal,
    onProgress: (ratio) => {
      task.progress = Math.round(ratio * 100);
      notifyProgress(task);
    },
  });
}

/**
 * Lets go of the material a macOS decryption rode on once the task is terminal.
 * It is never persisted, and a retry arrives with fresh material anyway.
 */
function stripDecryptionMaterial(task: DownloadTask): void {
  task.dpInfo = undefined;
  task.hardwareId = undefined;
}

// --- Security: sanitize task for API responses ---
export function sanitizeTaskForResponse(
  task: DownloadTask,
): Omit<
  DownloadTask,
  | "downloadURL"
  | "sinfs"
  | "iTunesMetadata"
  | "filePath"
  | "dpInfo"
  | "hardwareId"
> {
  const {
    downloadURL,
    sinfs,
    iTunesMetadata,
    filePath,
    dpInfo,
    hardwareId,
    ...safe
  } = task;
  return {
    ...safe,
    hasFile: task.hasFile ?? false,
    hasIcon: task.hasIcon ?? false,
  };
}

/**
 * The software shape persisted with a finished task. `metadataSource` is a
 * per-request hint, not a package property, so it is dropped before persistence.
 */
export function softwareForPersistence(software: Software): Software {
  const { metadataSource: _metadataSource, ...rest } = software;
  return rest;
}

// --- Persistence: save only completed task metadata (no secrets) ---
let stmtDeleteTask: import("better-sqlite3").Statement<[string]>;
let stmtUpsertTask: import("better-sqlite3").Statement<
  [string, string, string, string, number, string]
>;
let stmtSelectAllTaskIds: import("better-sqlite3").Statement<[]>;
let stmtSelectAllTasks: import("better-sqlite3").Statement<[]>;
let persistStmtsReady = false;

function ensurePersistStmts(): void {
  if (persistStmtsReady) return;
  const db = getDb();
  stmtDeleteTask = db.prepare("DELETE FROM tasks WHERE id = ?");
  stmtUpsertTask = db.prepare<
    [string, string, string, string, number, string]
  >(
    `INSERT OR REPLACE INTO tasks (id, software, account_hash, file_path, has_icon, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  stmtSelectAllTaskIds = db.prepare("SELECT id FROM tasks");
  stmtSelectAllTasks = db.prepare(
    "SELECT id, software, account_hash, file_path, has_icon, created_at FROM tasks",
  );
  persistStmtsReady = true;
}

function persistTasks() {
  const completed = Array.from(tasks.values())
    .filter((t) => t.status === "completed" && t.filePath);
  const currentIds = new Set(completed.map((t) => t.id));

  ensurePersistStmts();
  const db = getDb();
  const tx = db.transaction(() => {
    // Differential delete: remove rows no longer in the completed set.
    const existingRows = stmtSelectAllTaskIds.all() as Array<{ id: string }>;
    for (const row of existingRows) {
      if (!currentIds.has(row.id)) stmtDeleteTask.run(row.id);
    }
    for (const t of completed) {
      stmtUpsertTask.run(
        t.id,
        JSON.stringify(softwareForPersistence(t.software)),
        t.accountHash,
        t.filePath!,
        t.hasIcon ? 1 : 0,
        t.createdAt,
      );
    }
  });
  tx();
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
    deleteTaskInternal(id);
  }
  if (expiredIds.length > 0) persistTasks();
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
  let evicted = false;
  for (const ft of fileTasks) {
    console.log(`[Cleanup] Space limit exceeded, deleting task: ${ft.id}`);
    deleteTaskInternal(ft.id);
    evicted = true;
    totalBytes -= ft.size;
    if (totalBytes <= maxBytes) break;
  }
  if (evicted) persistTasks();
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

  // Open the DB (creates tables if absent) before the stores below use it.
  getDb();

  // Load the version metadata cache before the repair pass seeds it.
  initVersionMetadataCache();

  // Load version pins before the repair pass tops them up.
  initVersionPinStore();

  // Load the package-app index before the repair pass fills it.
  initPackageAppStore();

  // Legacy JSON files are migrated into SQLite on first DB open — see db.ts.

  // Load completed tasks from previous run
  ensurePersistStmts();
  const rows = stmtSelectAllTasks.all() as Array<{
    id: string;
    software: string;
    account_hash: string;
    file_path: string;
    has_icon: number;
    created_at: string;
  }>;

  for (const row of rows) {
    // Only restore completed tasks whose IPA file still exists
    if (!fs.existsSync(row.file_path)) {
      stmtDeleteTask.run(row.id);
      continue;
    }
    let software: Software;
    try {
      software = JSON.parse(row.software) as Software;
    } catch {
      stmtDeleteTask.run(row.id);
      continue;
    }
    const task: DownloadTask = {
      id: row.id,
      software,
      accountHash: row.account_hash,
      downloadURL: "",
      sinfs: [],
      status: "completed",
      progress: 100,
      speed: "0 B/s",
      filePath: row.file_path,
      hasFile: true,
      hasIcon: Boolean(row.has_icon),
      createdAt: row.created_at,
    };
    task.hasIcon = Boolean(iconPathFor(task));
    tasks.set(task.id, task);
  }

  // Clean up orphaned IPA files (files without a task)
  cleanOrphanedPackages();

  // Deliberately not awaited: file work over packages of hundreds of MB must
  // not hold up the server.
  void repairFinishedPackages().catch(() => {});

  // Run time-based cleanup once on startup, then schedule daily
  runTimeCleanup();
  scheduleDailyCleanup();
}

/**
 * Re-derives what a finished package actually contains, so a rule fix reaches
 * packages already on disk without forcing a re-download. Refreshes the icon
 * and the store metadata (icon URL included). Runs in the background.
 */
async function repairFinishedPackages(): Promise<void> {
  const finished = Array.from(tasks.values()).filter(
    (task) => task.status === "completed" && task.filePath,
  );
  let changed = 0;

  for (const task of finished) {
    const filePath = task.filePath;
    if (!filePath || !fs.existsSync(filePath)) continue;

    let info: Awaited<ReturnType<typeof readPackageInfo>>;
    try {
      info = await readPackageInfo(filePath);
    } catch (err) {
      console.warn(
        `[downloadManager] Could not read the package of ${task.id}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }

    if (applyPackageMetadata(task.software, info.metadata)) changed++;
    seedVersionMetadata(task.software.id, info.metadata);
    recordVersionPin(
      task.software.id,
      task.software.platform,
      task.software.externalVersionId,
    );
    rememberPackageApp(task.software);

    const stored = iconPathFor(task);
    const { icon } = info;

    if (icon) {
      if (stored && iconsMatch(stored, icon.data)) {
        task.hasIcon = true;
        continue;
      }
      writeTaskIcon(task, icon);
      changed++;
      continue;
    }

    if (stored) {
      fs.unlinkSync(stored);
      task.hasIcon = false;
      changed++;
    }
  }

  if (changed > 0) {
    console.log(
      `[downloadManager] Refreshed ${changed} finished package(s) from their contents`,
    );
    persistTasks();
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

/**
 * Removes a task, its files, and its bookkeeping without writing to the DB —
 * cleanup loops call this repeatedly and persist once at the end.
 */
function deleteTaskInternal(id: string): boolean {
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
    if (resolved.startsWith(packagesBase + path.sep)) {
      // A paused task's downloader is gone, so its .part leftovers are swept
      // here.
      removePartFiles(resolved);

      if (fs.existsSync(resolved)) {
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
  }

  tasks.delete(id);
  progressListeners.delete(id);
  return true;
}

export function deleteTask(id: string): boolean {
  const removed = deleteTaskInternal(id);
  if (removed) persistTasks();
  return removed;
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
    // Keep the .part files: resume skips the chunks that are already complete.
    downloader.abort(true);
    chunkDownloaders.delete(id);
  }

  task.status = "paused";
  notifyProgress(task);
  return true;
}

export function resumeTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "paused") return false;

  startDownloadSafely(task);
  return true;
}

/**
 * What a macOS task needs to decrypt Apple's package: the `dpInfo` the download
 * answered with and the hardware id it was requested with, both from the client.
 */
export interface MacOSDecryption {
  /** Base64 `dpInfo` from the download response's sinfs. */
  dpInfo: string;
  /** The request's hardware id (`guid`), hex encoded — the account's device id. */
  hardwareId: string;
}

/** A device id: an even number of hex digits, as Apple's `guid` is sent. */
const HARDWARE_ID_RE = /^([0-9a-fA-F]{2})+$/;

/**
 * Refuses a macOS task that could not be decrypted, so a tens-of-MB package is
 * not fetched only to find nothing can open it.
 */
function assertMacOSDecryption(decryption?: MacOSDecryption): void {
  if (!decryption) {
    throw new Error("A macOS download needs the dpInfo Apple answered with");
  }

  const { dpInfo, hardwareId } = decryption;
  if (typeof dpInfo !== "string" || dpInfo === "") {
    throw new Error("A macOS download needs the dpInfo Apple answered with");
  }
  if (typeof hardwareId !== "string" || !HARDWARE_ID_RE.test(hardwareId)) {
    throw new Error(
      "A macOS download needs the hex hardware id it was requested with",
    );
  }
}

export function createTask(
  software: Software,
  accountHash: string,
  downloadURL: string,
  sinfs: Sinf[],
  iTunesMetadata?: string,
  decryption?: MacOSDecryption,
): DownloadTask {
  validateDownloadURL(downloadURL);
  // …and that what Apple offered is a package this task's platform can use.
  assertPackageMatchesPlatform(downloadURL, software.platform);

  // The app id is required: it is what Apple is asked for and names the
  // directory when the bundle id is unknown.
  if (!Number.isInteger(software.id) || software.id <= 0) {
    throw new Error("Invalid app id");
  }
  safePathSegment(accountHash, "accountHash");
  appPathSegment(software);
  safePathSegment(software.version, "version");

  if (software.platform === "macos") {
    assertMacOSDecryption(decryption);
  }

  const task: DownloadTask = {
    id: uuidv4(),
    software,
    accountHash,
    downloadURL,
    sinfs,
    iTunesMetadata,
    dpInfo: decryption?.dpInfo,
    hardwareId: decryption?.hardwareId,
    status: "pending",
    progress: 0,
    speed: "0 B/s",
    createdAt: new Date().toISOString(),
  };

  tasks.set(task.id, task);
  startDownloadSafely(task);
  return task;
}

async function startDownload(task: DownloadTask) {
  // A resumed task keeps its progress: the downloader seeds the byte count from
  // the .part files a pause left behind.
  const resuming = task.status === "paused";

  // Pre-download cleanup runs before the attempt registers itself, so a throw
  // here has nothing registered to release (reported by `startDownloadSafely`).
  runTimeCleanup();
  runSpaceCleanup();

  const controller = new AbortController();
  // The attempt owns this registration for its whole lifecycle and releases it
  // in the `finally` below. The `catch` guard reads it to tell a superseded
  // attempt from the current one — releasing it earlier made post-download
  // failures look stale (task stuck `downloading` at 100%, reason discarded).
  abortControllers.set(task.id, controller);

  // Set a global timeout for the entire download
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    task.status = "downloading";
    if (!resuming) {
      task.progress = 0;
    }
    task.speed = "0 B/s";
    task.error = undefined;
    notifyProgress(task);

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
      throw new Error("Invalid path");
    }

    fs.mkdirSync(dir, { recursive: true });

    // macOS packages arrive as .pkg (a xar container), not an IPA: no sinfs to
    // inject and not unpackable as an IPA.
    const isMacOSPackage = task.software.platform === "macos";
    const filePath = path.join(
      dir,
      `${task.id}${isMacOSPackage ? ".pkg" : ".ipa"}`,
    );
    task.filePath = filePath;

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

    // Registration stays for the steps below, so their failures reach the task.
    clearTimeout(timeout);

    // Validates the package's declared platform before injecting — mirrors
    // ipatool's validatePackagePlatform, and its declaration is the authority
    // over the request's. Skipped for macOS (.pkg, not IPA).
    if (!isMacOSPackage) {
      const actualPlatform = await validatePackagePlatform(filePath);
      if (actualPlatform && actualPlatform !== task.software.platform) {
        task.software.platform = actualPlatform;
      }
    } else {
      // Apple serves a macOS download FairPlay-encrypted, so it is not yet a
      // .pkg; decrypting makes it one. A macOS task can still be served an IPA
      // (the MDM catalogue answers an iOS offer even for platform=osx), which
      // decryption refuses loudly.
      await decryptTaskPackage(task, filePath, controller.signal);
      await assertMacOSPackage(filePath);
    }

    // Inject sinfs; macOS packages cannot carry them, so the download is final.
    const compiled = task.sinfs.length > 0 && !isMacOSPackage;
    if (compiled) {
      task.status = "injecting";
      task.progress = 100;
      notifyProgress(task);

      const { metadata, icon } = await inject(
        task.sinfs,
        filePath,
        task.iTunesMetadata,
      );

      // A bare-app-id download knows almost nothing; fill in what the package
      // declares before persisting, so every view reports real values.
      applyPackageMetadata(task.software, metadata);

      // The package is the trusted source for the shared version metadata
      // cache.
      seedVersionMetadata(task.software.id, metadata);
      writeTaskIcon(task, icon);
    }

    // Apple's fileSizeBytes is the installed (uncompressed) size, not the file
    // size. Overwrite with the real on-disk size; it must come after injection
    // (which rewrites the archive) and is what the app index records below.
    task.software.fileSizeBytes = String(fs.statSync(filePath).size);

    // The app index: a delisted app stays findable by bundle id with everything
    // its package knew, the size above included.
    if (compiled) rememberPackageApp(task.software);

    // Record the version pin: the package is the last place a delisted app's
    // version id is readable.
    recordVersionPin(
      task.software.id,
      task.software.platform,
      task.software.externalVersionId,
    );

    task.status = "completed";
    task.progress = 100;
    task.hasFile = true;

    // Strip sensitive data after successful compile
    task.downloadURL = "";
    task.sinfs = [];
    task.iTunesMetadata = undefined;
    stripDecryptionMaterial(task);

    // Persist completed task metadata (no secrets)
    persistTasks();
    notifyProgress(task);
  } catch (err) {
    // A rapid pause → resume replaced this registration: the newer attempt owns
    // the task now, so this stale catch must not overwrite its status.
    if (abortControllers.get(task.id) !== controller) {
      clearTimeout(timeout);
      return;
    }

    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      // pauseTask() already removed the controller (caught above), so reaching
      // here means the download genuinely timed out.
      task.status = "failed";
      task.error = "Download timed out";
      stripDecryptionMaterial(task);
      notifyProgress(task);
      return;
    }

    task.status = "failed";
    console.error(
      `Download ${task.id} failed:`,
      err instanceof Error ? err.message : err,
    );
    // The specific reason (platform mismatch, chunk HTTP error, decryption,
    // injection) is actionable; generic text hid it.
    task.error = err instanceof Error ? err.message : "Download failed";
    stripDecryptionMaterial(task);
    notifyProgress(task);
  } finally {
    // Only this attempt's registration is released; a newer one has its own.
    if (abortControllers.get(task.id) === controller) {
      abortControllers.delete(task.id);
      chunkDownloaders.delete(task.id);
    }
  }
}

/**
 * Fires a download without awaiting it and absorbs any out-of-band rejection as
 * an unhandled rejection would take down the process. A rejection reaching here
 * has no registration to release — the attempt releases its own.
 */
function startDownloadSafely(task: DownloadTask): void {
  void startDownload(task).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Download failed";
    task.status = "failed";
    task.error = message;
    stripDecryptionMaterial(task);
    notifyProgress(task);
  });
}
