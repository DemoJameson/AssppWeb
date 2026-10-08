import { getDb } from "./db.js";
import type { Platform } from "../types/index.js";

/**
 * Instance-wide version-pin store (`appId + platform -> external version id`) over the
 * `version_pins` table, recorded passively from the tasks the pipeline compiled. A tvOS /
 * visionOS / macOS version list is only fetchable when the download-product exchange is pinned to
 * a version id that exists for that platform; for a delisted app that id can no longer be looked
 * up, so recording it keeps the app queryable. Server-written only, from `recordVersionPin` call
 * sites in downloadManager — never from a request body.
 */

const PLATFORM_SET: ReadonlySet<string> = new Set([
  "ios",
  "ipad",
  "tvos",
  "visionos",
  "macos",
]);

let initialized = false;

// Module-level prepared statements — prepared once, reused across calls.
let stmtSelectPin: import("better-sqlite3").Statement<[number, string]> | undefined;
let stmtUpsertPin: import("better-sqlite3").Statement<[number, string, string, number]> | undefined;
let stmtSelectForApp: import("better-sqlite3").Statement<[number]> | undefined;

/** Ensures the table exists; idempotent, safe to call from any entry point. */
export function initVersionPinStore(): void {
  if (initialized) return;
  initialized = true;
  const db = getDb();
  stmtSelectPin = db.prepare<[number, string]>(
    "SELECT version_id FROM version_pins WHERE app_id = ? AND platform = ?",
  );
  stmtUpsertPin = db.prepare<[number, string, string, number]>(
    `INSERT OR REPLACE INTO version_pins (app_id, platform, version_id, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  stmtSelectForApp = db.prepare<[number]>(
    "SELECT platform, version_id FROM version_pins WHERE app_id = ? ORDER BY platform",
  );
}

/**
 * Drops the cached connection-bound statements and un-initializes the store, so the next
 * `initVersionPinStore` re-prepares against the fresh connection.
 */
export function resetVersionPinStoreForTest(): void {
  initialized = false;
  stmtSelectPin = undefined;
  stmtUpsertPin = undefined;
  stmtSelectForApp = undefined;
}

/**
 * Records the version id a finished package carried for its platform. Version ids are
 * assigned in release order, so the largest id seen for a platform is the newest known
 * release — the best pin for future exchanges regardless of download order.
 */
export function recordVersionPin(
  appId: string | number,
  platform: string | undefined,
  versionId: string | undefined,
): void {
  initVersionPinStore();

  const appKey = String(appId).trim();
  const platformKey = (platform ?? "ios").trim();
  const versionKey = (versionId ?? "").trim();

  if (!isNumericId(appKey) || !isNumericId(versionKey)) return;
  if (!PLATFORM_SET.has(platformKey)) return;

  const existing = stmtSelectPin!.get(Number(appKey), platformKey) as
    | { version_id: string }
    | undefined;

  if (existing && Number(existing.version_id) >= Number(versionKey)) return;

  stmtUpsertPin!.run(Number(appKey), platformKey, versionKey, Date.now());
}

/** Read access for the route: public fields only. */
export function getVersionPinsForApp(
  appId: string | number,
): Array<{ platform: Platform; versionId: string }> {
  initVersionPinStore();
  const rows = stmtSelectForApp!.all(Number(String(appId).trim())) as Array<{
    platform: string;
    version_id: string;
  }>;

  return rows.map((r) => ({
    platform: r.platform as Platform,
    versionId: r.version_id,
  }));
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}
