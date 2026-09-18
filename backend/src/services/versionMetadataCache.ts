import fs from "fs";
import path from "path";
import { config, VERSION_METADATA_MAX_ENTRIES } from "../config.js";
import type { PackageMetadata } from "./sinfInjector.js";

/**
 * The instance-wide version metadata cache: `appId -> versionId -> entry`,
 * served to every client of this instance.
 *
 * Entries come from two sources. The download pipeline seeds what compiled
 * packages read back (the `seedVersionMetadata` call sites in downloadManager),
 * and clients may save metadata they fetched live from Apple through
 * `saveClientVersionMetadata` — the server itself never contacts Apple (it
 * holds no credentials). Package-sourced entries are immutable and always win
 * over client-saved ones: the IPA is the authority on the build it contains.
 */

export type VersionMetadataSource = "package" | "client";

export interface VersionMetadataEntry {
  versionId: string;
  displayVersion: string;
  releaseDate: string;
  /** `package` = read back from a compiled IPA; `client` = saved by a browser. */
  source: VersionMetadataSource;
  /** Kept for eviction ordering; not part of the API response. */
  seededAt: number;
}

const CACHE_FILE = path.join(config.dataDir, "version-metadata.json");
const MAX_VALUE_LENGTH = 64;

/** appId -> versionId -> entry */
const apps = new Map<string, Map<string, VersionMetadataEntry>>();

let loaded = false;
let persistTimer: NodeJS.Timeout | null = null;

/** Loads the on-disk cache; idempotent, safe to call from any entry point. */
export function initVersionMetadataCache(): void {
  if (loaded) return;
  loaded = true;

  if (!fs.existsSync(CACHE_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as {
      schema?: unknown;
      entries?: unknown;
    };
    if (
      data.schema !== 1 ||
      typeof data.entries !== "object" ||
      data.entries === null
    ) {
      return;
    }

    for (const [appId, versions] of Object.entries(data.entries)) {
      if (
        !isNumericId(appId) ||
        typeof versions !== "object" ||
        versions === null
      ) {
        continue;
      }

      const bucket = new Map<string, VersionMetadataEntry>();
      for (const [versionId, raw] of Object.entries(versions)) {
        const entry = validateEntry(versionId, raw);
        if (entry) bucket.set(versionId, entry);
      }
      if (bucket.size > 0) apps.set(appId, bucket);
    }
  } catch {
    // Corrupted file — start fresh, the same tolerance tasks.json gets.
  }
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

  let bucket = apps.get(appKey);
  const existing = bucket?.get(versionId);
  if (existing?.source === "package") return;
  if (!bucket) {
    bucket = new Map<string, VersionMetadataEntry>();
    apps.set(appKey, bucket);
  }

  bucket.set(versionId, {
    versionId,
    displayVersion,
    releaseDate,
    source: "package",
    seededAt: Date.now(),
  });

  evictOldest();
  schedulePersist();
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
  entry?: { versionId: string; displayVersion: string; releaseDate: string };
} {
  initVersionMetadataCache();

  const appKey = String(appId).trim();
  const versionKey = String(versionId).trim();
  const display = cleanValue(displayVersion);
  const release = cleanValue(releaseDate);

  if (!isNumericId(appKey) || !isNumericId(versionKey)) return { saved: false };
  if (!display || !release) return { saved: false };

  let bucket = apps.get(appKey);
  const existing = bucket?.get(versionKey);
  if (existing?.source === "package") {
    return { saved: false, entry: publicEntry(existing) };
  }
  if (!bucket) {
    bucket = new Map<string, VersionMetadataEntry>();
    apps.set(appKey, bucket);
  }

  const entry: VersionMetadataEntry = {
    versionId: versionKey,
    displayVersion: display,
    releaseDate: release,
    source: "client",
    seededAt: Date.now(),
  };
  bucket.set(versionKey, entry);

  evictOldest();
  schedulePersist();
  return { saved: true, entry: publicEntry(entry) };
}

/** Read access for the route: storefront-public fields only. */
export function getVersionMetadataForApp(
  appId: string | number,
): Array<{ versionId: string; displayVersion: string; releaseDate: string }> {
  const bucket = apps.get(String(appId).trim());
  if (!bucket) return [];

  return Array.from(bucket.values()).map(publicEntry);
}

function publicEntry({
  versionId,
  displayVersion,
  releaseDate,
}: VersionMetadataEntry): {
  versionId: string;
  displayVersion: string;
  releaseDate: string;
} {
  return { versionId, displayVersion, releaseDate };
}

/** Writes the cache immediately, skipping the debounce (tests, shutdown). */
export function flushVersionMetadataCache(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
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

function validateEntry(
  versionId: string,
  raw: unknown,
): VersionMetadataEntry | undefined {
  if (!isNumericId(versionId) || typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const displayVersion = cleanValue(record.displayVersion);
  const releaseDate = cleanValue(record.releaseDate);
  if (!displayVersion || !releaseDate) return undefined;

  // Files written before sources existed came from packages only.
  const source: VersionMetadataSource =
    record.source === "client" ? "client" : "package";

  const seededAt =
    typeof record.seededAt === "number" && Number.isFinite(record.seededAt)
      ? record.seededAt
      : Date.now();

  return { versionId, displayVersion, releaseDate, source, seededAt };
}

/** Evicts oldest-seeded entries until the directory fits the configured cap. */
function evictOldest(): void {
  let total = 0;
  for (const bucket of apps.values()) total += bucket.size;

  while (total > VERSION_METADATA_MAX_ENTRIES) {
    let oldestApp: string | null = null;
    let oldestVersionId: string | null = null;
    let oldestSeededAt = Number.POSITIVE_INFINITY;

    for (const [appId, bucket] of apps) {
      for (const entry of bucket.values()) {
        if (entry.seededAt < oldestSeededAt) {
          oldestSeededAt = entry.seededAt;
          oldestApp = appId;
          oldestVersionId = entry.versionId;
        }
      }
    }

    if (oldestApp === null || oldestVersionId === null) return;
    const bucket = apps.get(oldestApp);
    bucket?.delete(oldestVersionId);
    if (bucket && bucket.size === 0) apps.delete(oldestApp);
    total--;
  }
}

// Seeding arrives in bursts (a repair pass reads many packages in a row), so
// the file write is debounced and always persists the full current state.
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 100);
}

function persistNow(): void {
  const entries: Record<string, Record<string, VersionMetadataEntry>> = {};
  for (const [appId, bucket] of apps) {
    if (bucket.size === 0) continue;
    const versions: Record<string, VersionMetadataEntry> = {};
    for (const [versionId, entry] of bucket) {
      versions[versionId] = entry;
    }
    entries[appId] = versions;
  }

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ schema: 1, entries }, null, 2),
    );
  } catch (err) {
    console.warn(
      `[versionMetadataCache] Could not persist the cache: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}
