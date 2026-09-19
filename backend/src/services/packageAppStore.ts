import fs from "fs";
import path from "path";
import { config } from "../config.js";
import type { Platform, Software } from "../types/index.js";

/**
 * The instance-wide package-app index: what past downloads' compiled packages
 * know about the apps they contain — `appId -> { bundleID, name, builds }`.
 *
 * The App Store forgets apps once they are delisted: a lookup by bundle id
 * comes back empty even though the app was downloaded before. The compiled
 * package still remembers what the storefront knew at download time (the
 * iTunesMetadata the package carries), so this index is what lets a delisted
 * app be found by its bundle id again. It complements the version-pin store:
 * pins keep a delisted app's version list alive, this keeps the app itself
 * findable.
 *
 * Builds are tracked per platform: the same app ships different versions for
 * different platforms (`Forward` was 1.3.18 on iOS and 1.3.19 on tvOS), so a
 * lookup answers with the build of the platform it asked for — and says
 * nothing about the version when that platform has no recorded package.
 *
 * Server-written only (no client write-back), like the version metadata cache:
 * entries come from `rememberPackageApp` call sites in downloadManager — the
 * compile pipeline and the startup repair pass.
 */

const APPS_FILE = path.join(config.dataDir, "package-apps.json");

const PLATFORM_SET: ReadonlySet<string> = new Set([
  "ios",
  "ipad",
  "tvos",
  "visionos",
  "macos",
]);

/** One platform's build of the app, as a compiled package described it. */
export interface PackageBuild {
  version?: string;
  minimumOsVersion?: string;
  updatedAt: number;
}

export interface PackageAppRecord {
  appId: string;
  bundleID: string;
  name?: string;
  artistName?: string;
  artworkUrl?: string;
  primaryGenreName?: string;
  /** platform -> build (versions differ per platform) */
  builds: Record<string, PackageBuild>;
  updatedAt: number;
}

/** appId -> record */
const apps = new Map<string, PackageAppRecord>();

let loaded = false;
let persistTimer: NodeJS.Timeout | null = null;

/** Loads the on-disk index; idempotent, safe to call from any entry point. */
export function initPackageAppStore(): void {
  if (loaded) return;
  loaded = true;

  if (!fs.existsSync(APPS_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(APPS_FILE, "utf-8")) as {
      apps?: unknown;
    };
    if (typeof data.apps !== "object" || data.apps === null) return;

    for (const [appId, raw] of Object.entries(data.apps)) {
      if (!isNumericId(appId)) continue;
      const record = validateRecord(appId, raw);
      if (record) apps.set(appId, record);
    }
  } catch {
    // Corrupted file — start fresh, the same tolerance the other stores get.
  }
}

/**
 * Records what a compiled package said about its app and platform. Packages
 * without a bundle id are skipped: they could never answer a bundle-id lookup.
 * Values from the new read win when present; the previous build fills the
 * gaps, and the placeholder label `App <id>` never counts as a name.
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

  const existing = apps.get(appKey);
  const previousBuild = existing?.builds[platform];
  const build: PackageBuild = {
    version: clean(software.version) ?? previousBuild?.version,
    minimumOsVersion:
      clean(software.minimumOsVersion) ?? previousBuild?.minimumOsVersion,
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

  // Boot-time repair re-reads every package; skip the write when the record
  // already says the same thing.
  if (existing && sameRecord(existing, record)) return;

  apps.set(appKey, record);
  schedulePersist();
}

/** Bundle-id lookup for the catalogue fallback. Case-insensitive. */
export function findPackageAppByBundleId(
  bundleId: string,
): PackageAppRecord | undefined {
  initPackageAppStore();

  const key = bundleId.trim().toLowerCase();
  if (!key) return undefined;

  for (const record of apps.values()) {
    if (record.bundleID.toLowerCase() === key) return record;
  }
  return undefined;
}

/** App-id lookup for the catalogue fallback. */
export function findPackageAppByAppId(
  appId: string | number,
): PackageAppRecord | undefined {
  initPackageAppStore();
  return apps.get(String(appId).trim());
}

/**
 * Name search for the catalogue merge: case-insensitive substring over the
 * records' names, most recently updated first. Records without a real name
 * have nothing to match.
 */
export function searchPackageAppsByName(term: string): PackageAppRecord[] {
  initPackageAppStore();
  const needle = term.trim().toLowerCase();
  if (!needle) return [];

  const matches: PackageAppRecord[] = [];
  for (const record of apps.values()) {
    if (record.name && record.name.toLowerCase().includes(needle)) {
      matches.push(record);
    }
  }
  return matches.sort((a, b) => b.updatedAt - a.updatedAt);
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

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validateRecord(
  appId: string,
  raw: unknown,
): PackageAppRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;

  const record = raw as Record<string, unknown>;
  const bundleID =
    typeof record.bundleID === "string" ? record.bundleID.trim() : "";
  if (!bundleID) return undefined;

  const builds = validateBuilds(record.builds);

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

  return {
    appId,
    bundleID,
    name: stringField(record.name),
    artistName: stringField(record.artistName),
    artworkUrl: stringField(record.artworkUrl),
    primaryGenreName: stringField(record.primaryGenreName),
    builds,
    updatedAt: numberOr(record.updatedAt, Date.now()),
  };
}

function validateBuilds(raw: unknown): Record<string, PackageBuild> {
  const builds: Record<string, PackageBuild> = {};
  if (typeof raw !== "object" || raw === null) return builds;

  for (const [platform, value] of Object.entries(raw)) {
    if (!PLATFORM_SET.has(platform) || typeof value !== "object" || value === null)
      continue;
    const build = value as Record<string, unknown>;
    builds[platform] = {
      version: stringField(build.version),
      minimumOsVersion: stringField(build.minimumOsVersion),
      updatedAt: numberOr(build.updatedAt, Date.now()),
    };
  }
  return builds;
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
      left.version !== right.version ||
      left.minimumOsVersion !== right.minimumOsVersion
    ) {
      return false;
    }
  }
  return true;
}

/** Writes the index immediately, skipping the debounce (tests, shutdown). */
export function flushPackageAppStore(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
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
  const entries: Record<string, Omit<PackageAppRecord, "appId">> = {};
  for (const [appId, record] of apps) {
    const { appId: _appId, ...rest } = record;
    entries[appId] = rest;
  }

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(
      APPS_FILE,
      JSON.stringify({ schema: 2, apps: entries }, null, 2),
    );
  } catch (err) {
    console.warn(
      `[packageAppStore] Could not persist the index: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}
