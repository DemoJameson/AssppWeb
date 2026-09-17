import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { timingSafeEqual } from "crypto";

/**
 * Local-dev fallback for the build info below: when BUILD_COMMIT/BUILD_DATE
 * are not injected (plain `npm run dev`), identify the checked-out revision so
 * local builds identify themselves. Containers have no .git, so this quietly
 * yields an empty result and the caller falls back to "unknown".
 */
let gitRevision: { commit: string; date: string } | null = null;
function readGitRevision(): { commit: string; date: string } {
  if (gitRevision) return gitRevision;
  gitRevision = { commit: "", date: "" };
  try {
    const output = execFileSync("git", ["log", "-1", "--format=%H%n%cI"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const [commit = "", date = ""] = output.trim().split(/\r?\n/);
    gitRevision = { commit, date };
  } catch {
    // No git available: keep "unknown".
  }
  return gitRevision;
}

export const config = {
  port: parseInt(process.env.PORT || "8080"),
  dataDir: process.env.DATA_DIR || "./data",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  disableHttpsRedirect:
    process.env.UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT === "true",
  // Auto-cleanup: 0 disables
  autoCleanupDays: parseInt(process.env.AUTO_CLEANUP_DAYS || "0", 10) || 0,
  autoCleanupMaxMB: parseInt(process.env.AUTO_CLEANUP_MAX_MB || "0", 10) || 0,
  // Max download file size in MB (0 disables)
  maxDownloadMB: parseInt(process.env.MAX_DOWNLOAD_MB || "0", 10) || 0,
  // Build info (injected via Docker build args; plain `npm run dev` falls back
  // to the checked-out git revision so local builds identify themselves).
  buildCommit:
    process.env.BUILD_COMMIT || readGitRevision().commit || "unknown",
  buildDate: process.env.BUILD_DATE || readGitRevision().date || "unknown",
  // Access password protection (empty = disabled)
  accessPassword: process.env.ACCESS_PASSWORD || "",
};

export const accessPasswordHash = config.accessPassword
  ? createHash("sha256").update(config.accessPassword).digest("hex")
  : "";

/** Timing-safe comparison of a client-supplied token against the precomputed hash. */
export function verifyAccessToken(token: string): boolean {
  const expected = Buffer.from(accessPasswordHash, "utf8");
  const actual = Buffer.from(token, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const MAX_DOWNLOAD_SIZE = 8 * 1024 * 1024 * 1024; // 8 GB
export const DOWNLOAD_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours
export const BAG_TIMEOUT_MS = 15_000; // 15 seconds
export const BAG_MAX_BYTES = 1024 * 1024; // 1 MB
export const MIN_ACCOUNT_HASH_LENGTH = 8;

// Shared version metadata cache: entry cap for the (appId, versionId) directory
// seeded passively from compiled packages (oldest entries evicted first).
export const VERSION_METADATA_MAX_ENTRIES = Math.max(
  1,
  parseInt(process.env.VERSION_METADATA_MAX_ENTRIES || "20000", 10) || 20000,
);

// Chunked download settings
export const DOWNLOAD_THREADS = Math.max(
  1,
  Math.min(32, parseInt(process.env.DOWNLOAD_THREADS || "8", 10) || 8),
);
export const CHUNK_RETRY_COUNT = 3;
export const CHUNK_RETRY_DELAY_MS = 2000;
