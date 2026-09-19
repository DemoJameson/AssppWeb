import { getDb } from "./db.js";
import { VERSION_METADATA_MAX_ENTRIES } from "../config.js";
import type { PackageMetadata } from "./sinfInjector.js";

/**
 * The instance-wide version metadata cache: `appId -> versionId -> entry`,
 * served to every client of this instance.
 *
 * Backed by the `version_metadata` SQLite table. Entries come from two
 * sources: the download pipeline seeds what compiled packages read back
 * (`seedVersionMetadata`), and clients may save metadata they fetched live
 * from Apple through `saveClientVersionMetadata` — the server itself never
 * contacts Apple (it holds no credentials). Package-sourced entries are
 * immutable and always win over client-saved ones: the IPA is the authority
 * on the build it contains.
 */

export type VersionMetadataSource = "package" | "client";

const MAX_VALUE_LENGTH = 64;

let initialized = false;

// Module-level prepared statements — prepared once, reused across calls.
let stmtSelectSource: import("better-sqlite3").Statement<[number, number]> | undefined;
let stmtSelectEntry: import("better-sqlite3").Statement<[number, number]> | undefined;
let stmtUpsertPackage: import("better-sqlite3").Statement<[number, number, string, string, number]> | undefined;
let stmtUpsertClient: import("better-sqlite3").Statement<[number, number, string, string, number]> | undefined;
let stmtSelectForApp: import("better-sqlite3").Statement<[number]> | undefined;
let stmtCount: import("better-sqlite3").Statement<[]> | undefined;
let stmtEvict: import("better-sqlite3").Statement<[number]> | undefined;

/** Ensures the table exists; idempotent, safe to call from any entry point. */
export function initVersionMetadataCache(): void {
  if (initialized) return;
  initialized = true;
  const db = getDb();
  stmtSelectSource = db.prepare<[number, number]>(
    "SELECT source FROM version_metadata WHERE app_id = ? AND version_id = ?",
  );
  stmtSelectEntry = db.prepare<[number, number]>(
    "SELECT version_id, display_version, release_date, source FROM version_metadata WHERE app_id = ? AND version_id = ?",
  );
  stmtUpsertPackage = db.prepare<[number, number, string, string, number]>(
    `INSERT OR REPLACE INTO version_metadata
       (app_id, version_id, display_version, release_date, source, seeded_at)
     VALUES (?, ?, ?, ?, 'package', ?)`,
  );
  stmtUpsertClient = db.prepare<[number, number, string, string, number]>(
    `INSERT OR REPLACE INTO version_metadata
       (app_id, version_id, display_version, release_date, source, seeded_at)
     VALUES (?, ?, ?, ?, 'client', ?)`,
  );
  stmtSelectForApp = db.prepare<[number]>(
    `SELECT version_id, display_version, release_date, source
     FROM version_metadata WHERE app_id = ?`,
  );
  stmtCount = db.prepare<[]>("SELECT COUNT(*) AS n FROM version_metadata");
  stmtEvict = db.prepare<[number]>(
    `DELETE FROM version_metadata
     WHERE rowid IN (
       SELECT rowid FROM version_metadata
       ORDER BY seeded_at ASC LIMIT ?
     )`,
  );
}

/**
 * Drops the cached connection-bound statements and un-initializes the cache.
 * Call after the DB has been reset/closed and before the next
 * `initVersionMetadataCache`, which re-prepares against the fresh connection.
 */
export function resetVersionMetadataCacheForTest(): void {
  initialized = false;
  stmtSelectSource = undefined;
  stmtSelectEntry = undefined;
  stmtUpsertPackage = undefined;
  stmtUpsertClient = undefined;
  stmtSelectForApp = undefined;
  stmtCount = undefined;
  stmtEvict = undefined;
}

/**
 * Records what a compiled package knows about the version it contains. Only
 * displayable entries pass the gate (numeric ids plus both display fields);
 * anything else is silently skipped. A package entry is never rewritten, but
 * it does replace a client-saved entry — the IPA is the authority.
 */
export function seedVersionMetadata(
  appId: string | number,
  metadata: PackageMetadata,
): void {
  initVersionMetadataCache();

  const appKey = String(appId).trim();
  const versionId = String(metadata.externalVersionId ?? "").trim();
  const displayVersion = cleanValue(metadata.version);
  const releaseDate = cleanValue(metadata.releaseDate);

  if (!isNumericId(appKey) || !isNumericId(versionId)) return;
  if (!displayVersion || !releaseDate) return;


  const existing = stmtSelectSource!.get(Number(appKey), Number(versionId)) as
    | { source: string }
    | undefined;
  if (existing?.source === "package") return;

  stmtUpsertPackage!.run(Number(appKey), Number(versionId), displayVersion, releaseDate, Date.now());

  evictOldest();
}

/**
 * Saves metadata a client fetched live from Apple. It fills gaps and refreshes
 * earlier client-saved values, but never displaces a package entry — callers
 * get `saved: false` plus the entry that stays authoritative instead.
 */
export function saveClientVersionMetadata(
  appId: string | number,
  versionId: string,
  displayVersion: unknown,
  releaseDate: unknown,
): {
  saved: boolean;
  entry?: { versionId: string; displayVersion: string; releaseDate: string; source: VersionMetadataSource };
} {
  initVersionMetadataCache();

  const appKey = String(appId).trim();
  const versionKey = String(versionId).trim();
  const display = cleanValue(displayVersion);
  const release = cleanValue(releaseDate);

  if (!isNumericId(appKey) || !isNumericId(versionKey)) return { saved: false };
  if (!display || !release) return { saved: false };


  const existing = stmtSelectEntry!.get(Number(appKey), Number(versionKey)) as
    | {
        version_id: number;
        display_version: string;
        release_date: string;
        source: string;
      }
    | undefined;

  if (existing?.source === "package") {
    return {
      saved: false,
      entry: {
        versionId: String(existing.version_id),
        displayVersion: existing.display_version,
        releaseDate: existing.release_date,
        source: "package" as VersionMetadataSource,
      },
    };
  }

  stmtUpsertClient!.run(Number(appKey), Number(versionKey), display, release, Date.now());

  evictOldest();
  return {
    saved: true,
    entry: {
      versionId: versionKey,
      displayVersion: display,
      releaseDate: release,
      source: "client" as VersionMetadataSource,
    },
  };
}

/** Read access for the route: storefront-public fields only. */
export function getVersionMetadataForApp(
  appId: string | number,
): Array<{ versionId: string; displayVersion: string; releaseDate: string; source: VersionMetadataSource }> {
  initVersionMetadataCache();
  const rows = stmtSelectForApp!.all(Number(String(appId).trim())) as Array<{
    version_id: number;
    display_version: string;
    release_date: string;
    source: string;
  }>;

  return rows.map((r) => ({
    versionId: String(r.version_id),
    displayVersion: r.display_version,
    releaseDate: r.release_date,
    source: r.source as VersionMetadataSource,
  }));
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

function cleanValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return undefined;
  return trimmed;
}

/** Evicts oldest-seeded entries until the directory fits the configured cap. */
function evictOldest(): void {
  const count = (stmtCount!.get() as { n: number }).n;
  if (count <= VERSION_METADATA_MAX_ENTRIES) return;

  const toEvict = count - VERSION_METADATA_MAX_ENTRIES;
  stmtEvict!.run(toEvict);
}
