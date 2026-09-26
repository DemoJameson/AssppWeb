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
 *
 * `source` answers two separate questions, which is why it has three values
 * rather than two:
 *
 *   - **May this be shown as the build's date?** Only a value read out of the
 *     build's own package may. Apple's exchange dates the *app* — every pinned
 *     version of one app comes back with the same day — so a `client` entry is
 *     never printed as a version's date (see the frontend's `versionLabels`).
 *   - **May it be overwritten?** Everything except `package` may.
 *
 * `package` is the download pipeline reading a package *this instance compiled*,
 * which is the only read the server can attest. `package-read` is the same read
 * performed at a URL a *client* supplied: displayable, because the bytes did
 * come out of a package, but not authoritative, because the server cannot prove
 * that package is the build these ids name. Splitting the two is what lets a
 * version's real date survive a change browsers while keeping the permanent,
 * unoverwritable claim only the pipeline can make — a client-writable `package`
 * entry was a claim about any (app, version) pair that nothing could correct.
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
 * Drops the cached connection-bound statements and un-initializes the cache.
 * Call after the DB has been reset/closed and before the next
 * `initVersionMetadataCache`, which re-prepares against the fresh connection.
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
 * Records what a compiled package knows about the version it contains. Only
 * displayable entries pass the gate (numeric ids plus both display fields);
 * anything else is silently skipped. A package entry is never rewritten, but it
 * does replace anything weaker — the IPA is the authority.
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
 * Whether a write from `incoming` may replace an entry held by `existing`.
 *
 * A write may refresh its own kind and may improve on a weaker one, and the
 * pipeline's own compile (`package`) is never replaced — that is the one claim
 * the server can attest, and nothing a client sends should be able to undo it.
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
 * Saves one entry from a source weaker than the pipeline, under
 * {@link mayReplace}. Callers get `saved: false` plus the entry that stayed
 * instead when the write was declined.
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
 * Saves metadata a client fetched live from Apple. It fills gaps and refreshes
 * earlier client-saved values, but never displaces a value read out of a
 * package — callers get `saved: false` plus the entry that stayed instead.
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
 * Saves metadata read out of a build's own package, at a download URL a client
 * supplied (`POST /version-metadata/:appId/:versionId/package`).
 *
 * It is displayable — the bytes did come out of a package, which is the only
 * place a per-build date exists — but it is not authoritative, because the
 * server cannot prove that package is the build these ids name. So it may be
 * refreshed, and replaced by the pipeline's own compile, but it in turn
 * outranks a `client` entry (Apple's app-level date).
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
