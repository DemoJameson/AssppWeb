import { getDb } from "./db.js";
import type { Platform, Software } from "../types/index.js";

/**
 * The instance-wide package-app index: what past downloads' compiled packages
 * know about the apps they contain — `appId -> { bundleID, name, builds }`.
 *
 * Backed by the `package_apps` + `package_app_builds` SQLite tables. The App
 * Store forgets apps once they are delisted: a lookup by bundle id comes back
 * empty even though the app was downloaded before. The compiled package still
 * remembers what the storefront knew at download time (the iTunesMetadata the
 * package carries), so this index is what lets a delisted app be found by its
 * bundle id again. It complements the version-pin store: pins keep a delisted
 * app's version list alive, this keeps the app itself findable.
 *
 * Builds are tracked per platform: the same app ships different versions for
 * different platforms (`Forward` was 1.3.18 on iOS and 1.3.19 on tvOS), so a
 * lookup answers with the build of the platform it asked for — and says
 * nothing about the version when that platform has no recorded package. Each
 * build carries everything the package could tell about itself: Apple's
 * external version id, its version, minimum OS, release date, and the size it
 * occupies on disk.
 *
 * Server-written only (no client write-back): entries come from
 * `rememberPackageApp` call sites in downloadManager — the compile pipeline
 * and the startup repair pass.
 */

const PLATFORM_SET: ReadonlySet<string> = new Set([
  "ios",
  "ipad",
  "tvos",
  "visionos",
  "macos",
]);

export interface PackageBuild {
  /**
   * Apple's external version identifier for this build — the id a version list
   * is keyed by, read out of the package's store metadata. It is what lets a
   * detail view tie the record to one build of the list instead of guessing
   * from a version number two builds can share.
   */
  externalVersionId?: string;
  version?: string;
  minimumOsVersion?: string;
  /**
   * The compiled package's size on disk, as the user would download it. Apple's
   * `fileSizeBytes` is the installed size instead, so this is the only field
   * here the package cannot declare — the download pipeline measures it.
   */
  fileSizeBytes?: string;
  /**
   * When this build was released, read out of the package (its Info.plist, or
   * the archive entry's timestamp when that carries no date). Per build, not
   * per app: Apple's own `releaseDate` in the download reply is app-level and
   * can be stale, which is why the package is the source.
   */
  releaseDate?: string;
  updatedAt: number;
}

export interface PackageAppRecord {
  appId: string;
  bundleID: string;
  name?: string;
  artistName?: string;
  artworkUrl?: string;
  primaryGenreName?: string;
  builds: Record<string, PackageBuild>;
  updatedAt: number;
}

let initialized = false;

// Module-level prepared statements — prepared once, reused across calls.
let stmtSelectAppByBundle: import("better-sqlite3").Statement<[string]> | undefined;
let stmtSelectAppByName: import("better-sqlite3").Statement<[string]> | undefined;
let stmtSelectApp: import("better-sqlite3").Statement<[number]> | undefined;
let stmtSelectBuilds: import("better-sqlite3").Statement<[number]> | undefined;
let stmtUpsertApp: import("better-sqlite3").Statement<
  [number, string, string | undefined, string | undefined, string | undefined, string | undefined, number]
> | undefined;
let stmtUpsertBuild: import("better-sqlite3").Statement<
  [number, string, string | undefined, string | undefined, string | undefined, string | undefined, string | undefined, number]
> | undefined;

/** Ensures the tables exist; idempotent, safe to call from any entry point. */
export function initPackageAppStore(): void {
  if (initialized) return;
  initialized = true;
  const db = getDb();
  stmtSelectAppByBundle = db.prepare<[string]>(
    "SELECT app_id FROM package_apps WHERE bundle_id = ? COLLATE NOCASE LIMIT 1",
  );
  stmtSelectAppByName = db.prepare<[string]>(
    `SELECT app_id FROM package_apps
     WHERE name IS NOT NULL AND LOWER(name) LIKE ? ESCAPE '\\'
     ORDER BY updated_at DESC`,
  );
  stmtSelectApp = db.prepare<[number]>(
    "SELECT app_id, bundle_id, name, artist_name, artwork_url, primary_genre, updated_at FROM package_apps WHERE app_id = ?",
  );
  stmtSelectBuilds = db.prepare<[number]>(
    "SELECT platform, version_id, version, minimum_os, file_size, release_date, updated_at FROM package_app_builds WHERE app_id = ?",
  );
  stmtUpsertApp = db.prepare<
    [number, string, string | undefined, string | undefined, string | undefined, string | undefined, number]
  >(
    `INSERT INTO package_apps
       (app_id, bundle_id, name, artist_name, artwork_url, primary_genre, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       bundle_id = excluded.bundle_id,
       name = excluded.name,
       artist_name = excluded.artist_name,
       artwork_url = excluded.artwork_url,
       primary_genre = excluded.primary_genre,
       updated_at = excluded.updated_at`,
  );
  stmtUpsertBuild = db.prepare<
    [number, string, string | undefined, string | undefined, string | undefined, string | undefined, string | undefined, number]
  >(
    `INSERT INTO package_app_builds
       (app_id, platform, version_id, version, minimum_os, file_size, release_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id, platform) DO UPDATE SET
       version_id = excluded.version_id,
       version = excluded.version,
       minimum_os = excluded.minimum_os,
       file_size = excluded.file_size,
       release_date = excluded.release_date,
       updated_at = excluded.updated_at`,
  );
}

/**
 * Drops the cached connection-bound statements and un-initializes the store.
 * Call after the DB has been reset/closed and before the next
 * `initPackageAppStore`, which re-prepares against the fresh connection.
 */
export function resetPackageAppStoreForTest(): void {
  initialized = false;
  stmtSelectAppByBundle = undefined;
  stmtSelectAppByName = undefined;
  stmtSelectApp = undefined;
  stmtSelectBuilds = undefined;
  stmtUpsertApp = undefined;
  stmtUpsertBuild = undefined;
}

/**
 * Records what a compiled package said about its app and platform. Packages
 * without a bundle id are skipped: they could never answer a bundle-id lookup.
 * Values from the new read win when present; the previous build fills the
 * gaps, and the placeholder label `App <id>` never counts as a name.
 *
 * The size is the caller's on-disk measurement rather than anything the package
 * declares, so it only reaches the index when the completed task carries it —
 * like the external version id, which a task learns from the download reply and
 * the package's store metadata.
 */
export function rememberPackageApp(software: Software): void {
  initPackageAppStore();

  const appKey = String(software.id).trim();
  const bundleID = (software.bundleID ?? "").trim();
  if (!isNumericId(appKey) || !bundleID) return;

  const platform =
    software.platform && PLATFORM_SET.has(software.platform)
      ? software.platform
      : "ios";

  const existing = loadRecord(appKey);

  const previousBuild = existing?.builds[platform];
  const build: PackageBuild = {
    externalVersionId:
      clean(software.externalVersionId) ?? previousBuild?.externalVersionId,
    version: clean(software.version) ?? previousBuild?.version,
    minimumOsVersion:
      clean(software.minimumOsVersion) ?? previousBuild?.minimumOsVersion,
    fileSizeBytes:
      clean(software.fileSizeBytes) ?? previousBuild?.fileSizeBytes,
    releaseDate: clean(software.releaseDate) ?? previousBuild?.releaseDate,
    updatedAt: Date.now(),
  };
  const name = cleanName(software.name, appKey) ?? existing?.name;
  const record: PackageAppRecord = {
    appId: appKey,
    bundleID,
    name,
    artistName: clean(software.artistName) ?? existing?.artistName,
    artworkUrl: clean(software.artworkUrl) ?? existing?.artworkUrl,
    primaryGenreName:
      clean(software.primaryGenreName) ?? existing?.primaryGenreName,
    builds: { ...existing?.builds, [platform]: build },
    updatedAt: Date.now(),
  };

  if (existing && sameRecord(existing, record)) return;

  const db = getDb();
  const tx = db.transaction(() => {
    stmtUpsertApp!.run(
      Number(appKey),
      bundleID,
      record.name,
      record.artistName,
      record.artworkUrl,
      record.primaryGenreName,
      record.updatedAt,
    );

    for (const [plat, b] of Object.entries(record.builds)) {
      stmtUpsertBuild!.run(
        Number(appKey),
        plat,
        b.externalVersionId,
        b.version,
        b.minimumOsVersion,
        b.fileSizeBytes,
        b.releaseDate,
        b.updatedAt,
      );
    }
  });
  tx();
}

/** Bundle-id lookup for the catalogue fallback. Case-insensitive. */
export function findPackageAppByBundleId(
  bundleId: string,
): PackageAppRecord | undefined {
  initPackageAppStore();
  const key = bundleId.trim().toLowerCase();
  if (!key) return undefined;

  const row = stmtSelectAppByBundle!.get(key) as { app_id: number } | undefined;
  if (!row) return undefined;
  return loadRecord(String(row.app_id));
}

/** App-id lookup for the catalogue fallback. */
export function findPackageAppByAppId(
  appId: string | number,
): PackageAppRecord | undefined {
  initPackageAppStore();
  return loadRecord(String(appId).trim());
}

/**
 * Name search for the catalogue merge: case-insensitive substring over the
 * records' names, most recently updated first. Records without a real name
 * have nothing to match.
 */
export function searchPackageAppsByName(term: string): PackageAppRecord[] {
  initPackageAppStore();
  const needle = term.trim().toLowerCase();
  if (needle.length < 2) return [];

  const escaped = needle.replace(/[%_\\]/g, "\\$&");
  const rows = stmtSelectAppByName!.all(`%${escaped}%`) as Array<{
    app_id: number;
  }>;

  const matches: PackageAppRecord[] = [];
  for (const row of rows) {
    const record = loadRecord(String(row.app_id));
    if (record) matches.push(record);
  }
  return matches;
}

/**
 * The build a lookup should answer with: the requested platform's when it has
 * one, otherwise nothing — a tvOS build must not pass for an iOS one. With no
 * platform requested, any recorded build will do.
 */
export function buildForPlatform(
  record: PackageAppRecord,
  platform?: Platform,
): PackageBuild | undefined {
  if (platform && PLATFORM_SET.has(platform)) {
    return record.builds[platform];
  }
  return Object.values(record.builds)[0];
}

function loadRecord(appKey: string): PackageAppRecord | undefined {
  if (!isNumericId(appKey)) return undefined;
  const app = stmtSelectApp!.get(Number(appKey)) as
    | {
        app_id: number;
        bundle_id: string;
        name: string | null;
        artist_name: string | null;
        artwork_url: string | null;
        primary_genre: string | null;
        updated_at: number;
      }
    | undefined;
  if (!app) return undefined;

  const buildRows = stmtSelectBuilds!.all(Number(appKey)) as Array<{
    platform: string;
    version_id: string | null;
    version: string | null;
    minimum_os: string | null;
    file_size: string | null;
    release_date: string | null;
    updated_at: number;
  }>;

  const builds: Record<string, PackageBuild> = {};
  for (const b of buildRows) {
    builds[b.platform] = {
      externalVersionId: b.version_id ?? undefined,
      version: b.version ?? undefined,
      minimumOsVersion: b.minimum_os ?? undefined,
      fileSizeBytes: b.file_size ?? undefined,
      releaseDate: b.release_date ?? undefined,
      updatedAt: b.updated_at,
    };
  }

  return {
    appId: String(app.app_id),
    bundleID: app.bundle_id,
    name: app.name ?? undefined,
    artistName: app.artist_name ?? undefined,
    artworkUrl: app.artwork_url ?? undefined,
    primaryGenreName: app.primary_genre ?? undefined,
    builds,
    updatedAt: app.updated_at,
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The placeholder a bare-id download carries is not a real name. */
function cleanName(
  value: string | undefined,
  appId: string,
): string | undefined {
  const trimmed = clean(value);
  return trimmed === `App ${appId}` ? undefined : trimmed;
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

/** True when a fresh read carries nothing new (updatedAt alone doesn't count). */
function sameRecord(a: PackageAppRecord, b: PackageAppRecord): boolean {
  return (
    a.bundleID === b.bundleID &&
    a.name === b.name &&
    a.artistName === b.artistName &&
    a.artworkUrl === b.artworkUrl &&
    a.primaryGenreName === b.primaryGenreName &&
    sameBuilds(a.builds, b.builds)
  );
}

function sameBuilds(
  a: Record<string, PackageBuild>,
  b: Record<string, PackageBuild>,
): boolean {
  const platforms = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const platform of platforms) {
    const left = a[platform];
    const right = b[platform];
    if (!left || !right) return false;
    if (
      left.externalVersionId !== right.externalVersionId ||
      left.version !== right.version ||
      left.minimumOsVersion !== right.minimumOsVersion ||
      left.fileSizeBytes !== right.fileSizeBytes ||
      left.releaseDate !== right.releaseDate
    ) {
      return false;
    }
  }
  return true;
}
