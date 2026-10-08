import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { timingSafeEqual } from "crypto";

/**
 * Local-dev fallback for the build info: when BUILD_COMMIT/BUILD_DATE are not
 * injected, identify the checked-out revision. Containers have no .git, so this
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

const publicBaseUrls = parsePublicBaseUrls(process.env.PUBLIC_BASE_URL);

export const config = {
  port: parseInt(process.env.PORT || "8080"),
  dataDir: process.env.DATA_DIR || "./data",
  // Public origins install links may be built from, most preferred first; the
  // first answers for any host not itself listed. Not reported through
  // `/api/settings` — the deployment's own addresses are nobody else's business.
  publicBaseUrls,
  disableHttpsRedirect:
    process.env.UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT === "true",
  // Express's `trust proxy`, off by default. Behind a reverse proxy the socket
  // address is the proxy's, so every client shares one rate-limit bucket; set
  // this to key the limiter by the reported client instead. Off by default
  // because `X-Forwarded-For` is forgeable when nothing trustworthy sits in front.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Auto-cleanup: 0 disables
  autoCleanupDays: parseInt(process.env.AUTO_CLEANUP_DAYS || "0", 10) || 0,
  autoCleanupMaxMB: parseInt(process.env.AUTO_CLEANUP_MAX_MB || "0", 10) || 0,
  // Max download file size in MB (0 disables)
  maxDownloadMB: parseInt(process.env.MAX_DOWNLOAD_MB || "0", 10) || 0,
  // Storefronts a macOS/visionOS version lookup consults after the account's
  // own. Defaults to "cn" — the storefront reachable from a mainland-China
  // network, where every other one answers with a redirect; empty disables it.
  storefrontFallbackCountries: parseStorefrontFallbackCountries(
    process.env.STOREFRONT_FALLBACK_COUNTRIES,
  ),
  // Build info (injected via Docker build args; plain `npm run dev` falls back
  // to the checked-out git revision so local builds identify themselves).
  buildCommit:
    process.env.BUILD_COMMIT || readGitRevision().commit || "unknown",
  buildDate: process.env.BUILD_DATE || readGitRevision().date || "unknown",
  // Access password protection (empty = disabled)
  accessPassword: process.env.ACCESS_PASSWORD || "",
};

/**
 * Parses PUBLIC_BASE_URL: comma-separated public origins, most preferred first; the first answers
 * for any host not itself listed (a single value behaves like the plain single-URL form). Entries
 * are canonicalized — hostname lowercased, a default port dropped, trailing slashes trimmed — so a
 * configured value and a request `Host` compare equal. Anything not an absolute http(s) URL is
 * dropped, degrading to host auto-detection; `publicBaseUrlWarning` surfaces that.
 */
export function parsePublicBaseUrls(value: string | undefined): string[] {
  const entries = (value ?? "").split(",").map(normalizePublicBaseUrl);
  return [...new Set(entries.filter((entry) => entry !== ""))];
}

function normalizePublicBaseUrl(value: string): string {
  try {
    const { protocol, host, pathname } = new URL(value.trim());
    if (protocol !== "https:" && protocol !== "http:") return "";
    // A configured `https://X.example.com:443/app/` and a request's bare
    // `x.example.com` have to end up as the same string to be comparable.
    return `${protocol}//${host}${pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/**
 * What to log when `PUBLIC_BASE_URL` is set but contributes no origin — a
 * scheme-less hostname, a typo'd scheme, a stray comma. The deployment then goes
 * on serving install links off whatever `Host` arrives, easily mistaken for the
 * configuration having worked. Null when unset or working.
 */
export function publicBaseUrlWarning(
  value: string | undefined,
): string | null {
  const raw = (value ?? "").trim();
  if (raw === "" || parsePublicBaseUrls(raw).length > 0) return null;
  return (
    `PUBLIC_BASE_URL=${JSON.stringify(raw)} holds no absolute http(s) URL, so ` +
    `install links will fall back to the request Host. Expected a comma-separated ` +
    `list of origins, e.g. https://asspp.example.com,https://asspp.example.net`
  );
}

/**
 * Parses TRUST_PROXY for Express's `trust proxy`: unset (or "false") keeps it
 * off, "true" trusts every hop, a number trusts that many hops from the socket,
 * and anything else is passed through as Express's own address list ("loopback",
 * a subnet, or a comma-separated list of them).
 */
export function parseTrustProxy(
  value: string | undefined,
): boolean | number | string {
  const raw = (value ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Parses STOREFRONT_FALLBACK_COUNTRIES: comma-separated ISO 3166-1 country codes
 * (lowercased; entries that are not two letters are dropped). Unset keeps the
 * "cn" default, empty disables the fallback.
 */
export function parseStorefrontFallbackCountries(
  value: string | undefined,
): string[] {
  const raw = value ?? "cn";
  return [
    ...new Set(
      raw
        .split(",")
        .map((country) => country.trim().toLowerCase())
        .filter((country) => /^[a-z]{2}$/.test(country)),
    ),
  ];
}

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
// The iTunes Search/Lookup API, which `/search` and `/lookup` proxy. Node's
// fetch has no timeout, so a stalled storefront would hold the request (and, on
// `/search`, the re-check behind it) to undici's ~5 min default.
export const ITUNES_TIMEOUT_MS = 15_000;
export const BAG_MAX_BYTES = 1024 * 1024; // 1 MB
// Deadline for the HEAD/Range probes that verify an Apple file size before a
// download task is created; without it a stalled CDN hangs POST /downloads.
export const SIZE_PROBE_TIMEOUT_MS = 15_000;
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
