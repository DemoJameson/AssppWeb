import { getDb } from "./db.js";
import { VERSION_METADATA_MAX_ENTRIES } from "../config.js";
import type { PackageMetadata } from "./sinfInjector.js";

/**
 * Instance-wide version metadata cache (`appId -> versionId -> entry`) over the `version_metadata`
 * table; the server holds no credentials and never contacts Apple. Entries come from the pipeline
 * (`seedVersionMetadata`) or clients (`saveClientVersionMetadata`). Package-sourced entries are
 * immutable and win, and only a package-sourced date is displayable (Apple's dates the app — see
 * frontend `versionLabels`). `package` = a package this instance compiled (attestable);
 * `package-read` = the same read at a client-supplied URL — displayable, refreshable, but not
 * authoritative, yet still outranking `client`.
 */

export type VersionMetadataSource = "package" | "package-read" | "client";

const MAX_VALUE_LENGTH = 64;

let initialized = false;

// Module-level prepared statements — prepared once, reused across calls.
let stmtSelectSource: import("better-sqlite3").Statement<[number, number]> | undefined;
let stmtSelectEntry: import("better-sqlite3").Statement<[number, number]> | undefined;
let stmtUpsertPackage: import("better-sqlite3").Statement<[number, number, string, string, number]> | undefined;
let stmtUpsertPackageRead: import("better-sqlite3").Statement<[number, number, string, string, number]> | undefined;
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
  stmtUpsertPackageRead = db.prepare<[number, number, string, string, number]>(
    `INSERT OR REPLACE INTO version_metadata
       (app_id, version_id, display_version, release_date, source, seeded_at)
     VALUES (?, ?, ?, ?, 'package-read', ?)`,
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
 * Drops the cached connection-bound statements and un-initializes the cache, so the next
 * `initVersionMetadataCache` re-prepares against the fresh connection.
 */
export function resetVersionMetadataCacheForTest(): void {
  initialized = false;
  stmtSelectSource = undefined;
  stmtSelectEntry = undefined;
  stmtUpsertPackage = undefined;
  stmtUpsertPackageRead = undefined;
  stmtUpsertClient = undefined;
  stmtSelectForApp = undefined;
  stmtCount = undefined;
  stmtEvict = undefined;
}

/**
 * Records what a compiled package knows about its version. Only numeric ids plus both
 * display fields pass; others are skipped. A package entry is never rewritten but replaces
 * anything weaker — the IPA is the authority.
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
  if (existing && !mayReplace(existing.source, "package")) return;

  stmtUpsertPackage!.run(Number(appKey), Number(versionId), displayVersion, releaseDate, Date.now());

  evictOldest();
}

/**
 * Whether a write from `incoming` may replace an entry held by `existing`: it may refresh
 * its own kind or improve on a weaker one, but never replaces `package` — the one claim
 * the server can attest.
 */
function mayReplace(existing: string, incoming: VersionMetadataSource): boolean {
  if (existing === "package") return false;
  if (existing === "package-read") {
    return incoming === "package" || incoming === "package-read";
  }
  return true;
}

interface SavedEntry {
  versionId: string;
  displayVersion: string;
  releaseDate: string;
  source: VersionMetadataSource;
}

/**
 * Saves one entry from a source weaker than the pipeline, under {@link mayReplace}. A
 * declined write returns `saved: false` plus the entry that stayed.
 */
function saveEntry(
  appId: string | number,
  versionId: string,
  displayVersion: unknown,
  releaseDate: unknown,
  source: "package-read" | "client",
): { saved: boolean; entry?: SavedEntry } {
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

  if (existing && !mayReplace(existing.source, source)) {
    return {
      saved: false,
      entry: {
        versionId: String(existing.version_id),
        displayVersion: existing.display_version,
        releaseDate: existing.release_date,
        source: existing.source as VersionMetadataSource,
      },
    };
  }

  const statement =
    source === "package-read" ? stmtUpsertPackageRead! : stmtUpsertClient!;
  statement.run(Number(appKey), Number(versionKey), display, release, Date.now());

  evictOldest();
  return {
    saved: true,
    entry: { versionId: versionKey, displayVersion: display, releaseDate: release, source },
  };
}

/**
 * Saves metadata a client fetched live from Apple. It fills gaps and refreshes earlier
 * client-saved values but never displaces a package-sourced one, returning `saved: false`
 * plus the surviving entry when declined.
 */
export function saveClientVersionMetadata(
  appId: string | number,
  versionId: string,
  displayVersion: unknown,
  releaseDate: unknown,
): { saved: boolean; entry?: SavedEntry } {
  return saveEntry(appId, versionId, displayVersion, releaseDate, "client");
}

/**
 * Saves metadata read out of a build's own package at a client-supplied download URL
 * (`POST /version-metadata/:appId/:versionId/package`). Displayable — a per-build date exists only
 * in a package — but not authoritative, since the server cannot prove that package is the build
 * these ids name; it may be refreshed or replaced by the pipeline's compile, yet still outranks a
 * `client` entry.
 */
export function savePackageReadVersionMetadata(
  appId: string | number,
  versionId: string,
  displayVersion: unknown,
  releaseDate: unknown,
): { saved: boolean; entry?: SavedEntry } {
  return saveEntry(appId, versionId, displayVersion, releaseDate, "package-read");
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
