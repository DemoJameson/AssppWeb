import fs from "fs";
import path from "path";
import { config } from "../config.js";
import type { Platform } from "../types/index.js";

/**
 * The instance-wide version-pin store: `appId + platform -> external version id`,
 * recorded passively from the tasks the download pipeline compiled.
 *
 * A version list for tvOS / visionOS / macOS can only be fetched when the
 * download-product exchange is pinned to a version id that exists for that
 * platform — the pin is what makes Apple answer with the platform's build
 * instead of the account's default iOS one. For an app the storefront no
 * longer offers (delisted), that id cannot be looked up any more; but a past
 * download left the id behind in its finished package, so recording it here
 * keeps the app queryable.
 *
 * Server-written only (no client write-back), like the version metadata cache:
 * entries come from `recordVersionPin` call sites in downloadManager, never
 * from a request body.
 */

const PINS_FILE = path.join(config.dataDir, "version-pins.json");

const PLATFORM_SET: ReadonlySet<string> = new Set([
  "ios",
  "ipad",
  "tvos",
  "visionos",
  "macos",
]);

interface VersionPin {
  versionId: string;
  updatedAt: number;
}

/** appId -> platform -> pin */
const pins = new Map<string, Map<string, VersionPin>>();

let loaded = false;

/** Loads the on-disk store; idempotent, safe to call from any entry point. */
export function initVersionPinStore(): void {
  if (loaded) return;
  loaded = true;

  if (!fs.existsSync(PINS_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(PINS_FILE, "utf-8")) as {
      schema?: unknown;
      pins?: unknown;
    };
    if (
      data.schema !== 1 ||
      typeof data.pins !== "object" ||
      data.pins === null
    ) {
      return;
    }

    for (const [appId, platforms] of Object.entries(data.pins)) {
      if (
        !isNumericId(appId) ||
        typeof platforms !== "object" ||
        platforms === null
      ) {
        continue;
      }

      const bucket = new Map<string, VersionPin>();
      for (const [platform, raw] of Object.entries(platforms)) {
        if (!PLATFORM_SET.has(platform)) continue;
        const pin = validatePin(raw);
        if (pin) bucket.set(platform, pin);
      }
      if (bucket.size > 0) pins.set(appId, bucket);
    }
  } catch {
    // Corrupted file — start fresh, the same tolerance tasks.json gets.
  }
}

/**
 * Records the version id a finished package carried for its platform. Version
 * ids are assigned in release order, so the largest id seen for a platform is
 * the newest known release — the best pin for future exchanges, regardless of
 * the order the downloads happened in.
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

  let bucket = pins.get(appKey);
  if (!bucket) {
    bucket = new Map<string, VersionPin>();
    pins.set(appKey, bucket);
  }

  const existing = bucket.get(platformKey);
  if (existing && Number(existing.versionId) >= Number(versionKey)) return;

  bucket.set(platformKey, { versionId: versionKey, updatedAt: Date.now() });
  persistNow();
}

/** Read access for the route: public fields only. */
export function getVersionPinsForApp(
  appId: string | number,
): Array<{ platform: Platform; versionId: string }> {
  const bucket = pins.get(String(appId).trim());
  if (!bucket) return [];

  return Array.from(bucket.entries()).map(([platform, pin]) => ({
    platform: platform as Platform,
    versionId: pin.versionId,
  }));
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

function validatePin(raw: unknown): VersionPin | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;

  const record = raw as Record<string, unknown>;
  const versionId =
    typeof record.versionId === "string" ? record.versionId.trim() : "";
  if (!isNumericId(versionId)) return undefined;

  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now();

  return { versionId, updatedAt };
}

function persistNow(): void {
  const entries: Record<string, Record<string, VersionPin>> = {};
  for (const [appId, bucket] of pins) {
    if (bucket.size === 0) continue;
    const platforms: Record<string, VersionPin> = {};
    for (const [platform, pin] of bucket) {
      platforms[platform] = pin;
    }
    entries[appId] = platforms;
  }

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(
      PINS_FILE,
      JSON.stringify({ schema: 1, pins: entries }, null, 2),
    );
  } catch (err) {
    console.warn(
      `[versionPinStore] Could not persist the store: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}
