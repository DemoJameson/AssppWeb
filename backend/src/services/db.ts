import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config } from "../config.js";

/**
 * Single SQLite database backing every persistent store in the backend.
 *
 * Replaces the JSON files (tasks.json, and on the improve branch also
 * version-metadata.json, version-pins.json, package-apps.json) with one ACID,
 * WAL-mode database. Binary payloads (IPA, icons, SAP assets) stay on the
 * filesystem — only metadata and indexes live here.
 *
 * The DB is opened synchronously at first use and kept open for the process
 * lifetime. The first open migrates any leftover legacy JSON files into the
 * tables (then renames them aside). Tests reset the singleton via `closeDb()`
 * and re-import this module (its file paths bind to `config.dataDir` at load).
 */

const DB_FILE = path.join(config.dataDir, "asspp.db");

let db: Database.Database | null = null;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  software      TEXT NOT NULL,
  account_hash  TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  has_icon      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_hash);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

CREATE TABLE IF NOT EXISTS version_metadata (
  app_id          INTEGER NOT NULL,
  version_id      INTEGER NOT NULL,
  display_version TEXT NOT NULL,
  release_date    TEXT NOT NULL,
  source          TEXT NOT NULL,
  seeded_at       INTEGER NOT NULL,
  PRIMARY KEY (app_id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_vm_seeded ON version_metadata(seeded_at);

CREATE TABLE IF NOT EXISTS version_pins (
  app_id      INTEGER NOT NULL,
  platform    TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, platform)
);

CREATE TABLE IF NOT EXISTS package_apps (
  app_id        INTEGER PRIMARY KEY,
  bundle_id     TEXT NOT NULL,
  name          TEXT,
  artist_name   TEXT,
  artwork_url   TEXT,
  primary_genre TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pa_bundle ON package_apps(bundle_id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS package_app_builds (
  app_id      INTEGER NOT NULL,
  platform    TEXT NOT NULL,
  version     TEXT,
  minimum_os  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, platform),
  FOREIGN KEY (app_id) REFERENCES package_apps(app_id) ON DELETE CASCADE
);
`;

/** Sets `user_version` only on a fresh DB; future migrations branch on it. */
const SCHEMA_VERSION_SQL = `
PRAGMA user_version = 1;
`;

/** Opens (or returns the already-open) database handle. */
export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(DB_FILE);
  db.exec(SCHEMA_SQL);
  const version = (
    db.prepare("PRAGMA user_version").get() as { user_version?: number }
  ).user_version ?? 0;
  if (version === 0) {
    db.exec(SCHEMA_VERSION_SQL);
  }
  migrateLegacyJsonFiles(db);
  return db;
}

/** Closes the handle and clears the singleton (tests / shutdown). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Legacy JSON migration
//
// Every pre-SQLite store persisted a single JSON file under DATA_DIR. The
// first DB open imports each of them into the matching table and renames the
// file so the migration runs exactly once. A missing or already-migrated file
// is a no-op; a corrupted file is renamed aside (tolerated, like the stores
// always did). This is the shared migration — tasks.json is handled here
// alongside the three improve-branch stores.
// ---------------------------------------------------------------------------

const LEGACY_FILES = {
  tasks: path.join(config.dataDir, "tasks.json"),
  versionPins: path.join(config.dataDir, "version-pins.json"),
  versionMetadata: path.join(config.dataDir, "version-metadata.json"),
  packageApps: path.join(config.dataDir, "package-apps.json"),
} as const;

const PLATFORM_SET: ReadonlySet<string> = new Set([
  "ios",
  "ipad",
  "tvos",
  "visionos",
  "macos",
]);

function migrateLegacyJsonFiles(db: Database.Database): void {
  migrateTasksJson(db, LEGACY_FILES.tasks);
  migrateVersionPinsJson(db, LEGACY_FILES.versionPins);
  migrateVersionMetadataJson(db, LEGACY_FILES.versionMetadata);
  migratePackageAppsJson(db, LEGACY_FILES.packageApps);
}

/** Reads a legacy file, or undefined when absent/corrupt (renamed aside). */
function readLegacyJson(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.warn(
      `[db] Could not parse legacy ${path.basename(file)}, skipping migration: ${
        err instanceof Error ? err.message : err
      }`,
    );
    markMigrated(file, "broken");
    return undefined;
  }
}

/** Renames a file so the migration never sees it again. Best effort. */
function markMigrated(file: string, tag: string): void {
  try {
    fs.renameSync(file, `${file}.${tag}`);
  } catch {
    // Best effort.
  }
}

function migrateTasksJson(db: Database.Database, file: string): void {
  const data = readLegacyJson(file);
  if (data === undefined) return;

  if (!Array.isArray(data)) {
    markMigrated(file, "migrated");
    return;
  }

  const insert = db.prepare(
    "INSERT OR REPLACE INTO tasks (id, software, account_hash, file_path, has_icon, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  try {
    const tx = db.transaction(() => {
      for (const item of data) {
        const record = item as Record<string, unknown>;
        if (
          typeof record.id !== "string" ||
          typeof record.filePath !== "string" ||
          !record.software ||
          record.status !== "completed"
        ) {
          continue;
        }
        insert.run(
          record.id,
          JSON.stringify(record.software),
          String(record.accountHash ?? ""),
          record.filePath,
          Number(record.hasIcon ?? 0),
          String(record.createdAt ?? new Date().toISOString()),
        );
      }
    });
    tx();
  } catch (err) {
    console.warn(
      `[db] tasks.json migration failed, keeping the file: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return;
  }
  markMigrated(file, "migrated");
}

function migrateVersionPinsJson(db: Database.Database, file: string): void {
  const data = readLegacyJson(file);
  if (data === undefined) return;

  if (
    typeof data !== "object" ||
    data === null ||
    (data as { schema?: unknown }).schema !== 1 ||
    typeof (data as { pins?: unknown }).pins !== "object" ||
    (data as { pins?: unknown }).pins === null
  ) {
    markMigrated(file, "migrated");
    return;
  }

  const pins = (data as { pins: Record<string, unknown> }).pins;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO version_pins (app_id, platform, version_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  try {
    const tx = db.transaction(() => {
      for (const [appId, platforms] of Object.entries(pins)) {
        if (
          !isNumericId(appId) ||
          typeof platforms !== "object" ||
          platforms === null
        ) {
          continue;
        }
        for (const [platform, raw] of Object.entries(
          platforms as Record<string, unknown>,
        )) {
          if (!PLATFORM_SET.has(platform)) continue;
          if (typeof raw !== "object" || raw === null) continue;
          const { versionId, updatedAt } = raw as {
            versionId?: unknown;
            updatedAt?: unknown;
          };
          const versionKey =
            typeof versionId === "string" ? versionId.trim() : "";
          if (!isNumericId(versionKey)) continue;
          const at =
            typeof updatedAt === "number" && Number.isFinite(updatedAt)
              ? updatedAt
              : Date.now();
          insert.run(Number(appId), platform, versionKey, at);
        }
      }
    });
    tx();
  } catch (err) {
    console.warn(
      `[db] version-pins.json migration failed, keeping the file: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return;
  }
  markMigrated(file, "migrated");
}

function migrateVersionMetadataJson(db: Database.Database, file: string): void {
  const data = readLegacyJson(file);
  if (data === undefined) return;

  if (
    typeof data !== "object" ||
    data === null ||
    (data as { schema?: unknown }).schema !== 1 ||
    typeof (data as { entries?: unknown }).entries !== "object" ||
    (data as { entries?: unknown }).entries === null
  ) {
    markMigrated(file, "migrated");
    return;
  }

  const entries = (data as { entries: Record<string, unknown> }).entries;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO version_metadata (app_id, version_id, display_version, release_date, source, seeded_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  try {
    const tx = db.transaction(() => {
      for (const [appId, versions] of Object.entries(entries)) {
        if (!isNumericId(appId) || typeof versions !== "object" || versions === null) {
          continue;
        }
        for (const [versionId, raw] of Object.entries(
          versions as Record<string, unknown>,
        )) {
          if (!isNumericId(versionId)) continue;
          if (typeof raw !== "object" || raw === null) continue;
          const record = raw as {
            displayVersion?: unknown;
            releaseDate?: unknown;
            source?: unknown;
            seededAt?: unknown;
          };
          const displayVersion = stringField(record.displayVersion);
          const releaseDate = stringField(record.releaseDate);
          if (!displayVersion || !releaseDate) continue;
          // Files written before sources existed came from packages only.
          const source = record.source === "client" ? "client" : "package";
          const seededAt =
            typeof record.seededAt === "number" && Number.isFinite(record.seededAt)
              ? record.seededAt
              : Date.now();
          insert.run(
            Number(appId),
            Number(versionId),
            displayVersion,
            releaseDate,
            source,
            seededAt,
          );
        }
      }
    });
    tx();
  } catch (err) {
    console.warn(
      `[db] version-metadata.json migration failed, keeping the file: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return;
  }
  markMigrated(file, "migrated");
}

function migratePackageAppsJson(db: Database.Database, file: string): void {
  const data = readLegacyJson(file);
  if (data === undefined) return;

  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { apps?: unknown }).apps !== "object" ||
    (data as { apps?: unknown }).apps === null
  ) {
    markMigrated(file, "migrated");
    return;
  }

  const apps = (data as { apps: Record<string, unknown> }).apps;
  const insertApp = db.prepare(
    "INSERT OR REPLACE INTO package_apps (app_id, bundle_id, name, artist_name, artwork_url, primary_genre, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertBuild = db.prepare(
    "INSERT OR REPLACE INTO package_app_builds (app_id, platform, version, minimum_os, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  try {
    const tx = db.transaction(() => {
      for (const [appId, raw] of Object.entries(apps)) {
        if (!isNumericId(appId) || typeof raw !== "object" || raw === null) {
          continue;
        }
        const record = raw as Record<string, unknown>;
        const bundleID =
          typeof record.bundleID === "string" ? record.bundleID.trim() : "";
        if (!bundleID) continue;

        const builds = buildBuilds(record.builds);
        // Legacy (schema 1) shape: a flat record scoped to a single platform.
        if (
          Object.keys(builds).length === 0 &&
          typeof record.platform === "string" &&
          PLATFORM_SET.has(record.platform)
        ) {
          builds[record.platform] = {
            version: stringField(record.version),
            minimumOsVersion: stringField(record.minimumOsVersion),
            updatedAt: numberOr(record.updatedAt, Date.now()),
          };
        }

        insertApp.run(
          Number(appId),
          bundleID,
          stringField(record.name),
          stringField(record.artistName),
          stringField(record.artworkUrl),
          stringField(record.primaryGenreName),
          numberOr(record.updatedAt, Date.now()),
        );
        for (const [platform, build] of Object.entries(builds)) {
          insertBuild.run(
            Number(appId),
            platform,
            build.version,
            build.minimumOsVersion,
            build.updatedAt,
          );
        }
      }
    });
    tx();
  } catch (err) {
    console.warn(
      `[db] package-apps.json migration failed, keeping the file: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return;
  }
  markMigrated(file, "migrated");
}

function buildBuilds(raw: unknown): Record<
  string,
  { version?: string; minimumOsVersion?: string; updatedAt: number }
> {
  const builds: Record<
    string,
    { version?: string; minimumOsVersion?: string; updatedAt: number }
  > = {};
  if (typeof raw !== "object" || raw === null) return builds;
  for (const [platform, value] of Object.entries(raw)) {
    if (!PLATFORM_SET.has(platform) || typeof value !== "object" || value === null) {
      continue;
    }
    const build = value as Record<string, unknown>;
    builds[platform] = {
      version: stringField(build.version),
      minimumOsVersion: stringField(build.minimumOsVersion),
      updatedAt: numberOr(build.updatedAt, Date.now()),
    };
  }
  return builds;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}