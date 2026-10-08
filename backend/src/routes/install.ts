import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { getAllTasks, iconPathFor } from "../services/downloadManager.js";
import { buildManifest, getWhitePng } from "../services/manifestBuilder.js";
import { createInstallTicket } from "../utils/downloadTicket.js";
import { getIdParam } from "../utils/route.js";

const router = Router();

/**
 * The base URL install links are built from: the configured public origin whose
 * hostname the request arrived under, else the request's own view of itself.
 */
export function getBaseUrl(req: Request): string {
  if (config.publicBaseUrls.length > 0) {
    return matchConfiguredBaseUrl(config.publicBaseUrls, requestHost(req));
  }
  return detectedBaseUrl(req);
}

/**
 * Picks the configured origin to build links from for a request under `host`. Matching is on
 * hostname alone — the port in `Host` is untrusted (a proxy may forward an internal port no device
 * can reach), so the configured entry's full origin, scheme and port included, is emitted. An
 * unlisted host gets the first entry; a request port only disambiguates entries for the same
 * hostname, never adds one.
 */
export function matchConfiguredBaseUrl(
  candidates: string[],
  host: string,
): string {
  const hostname = requestHostname(host);
  const matching = candidates.filter(
    (candidate) => configuredHostname(candidate) === hostname,
  );
  if (matching.length <= 1) return matching[0] ?? candidates[0] ?? "";

  const port = requestPort(host);
  return (
    matching.find((candidate) => configuredPort(candidate) === port) ??
    matching[0]
  );
}

function configuredHostname(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The port an origin names, "" when it leaves the scheme's default implied. */
function configuredPort(origin: string): string {
  try {
    // URL parsing already drops `:443` for https and `:80` for http.
    return new URL(origin).port;
  } catch {
    return "";
  }
}

/** Splits a `Host` value into hostname and port. A bracketed IPv6 literal keeps
 * its brackets; its port is only what follows the closing bracket. */
function splitHostPort(host: string): { hostname: string; port: string } {
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(host);
  if (bracketed) {
    return { hostname: `[${bracketed[1]}]`, port: bracketed[2] ?? "" };
  }
  const plain = /^([^:]*)(?::(\d+))?$/.exec(host);
  if (plain) return { hostname: plain[1], port: plain[2] ?? "" };
  return { hostname: host, port: "" };
}

function requestHostname(host: string): string {
  return splitHostPort(host).hostname.toLowerCase();
}

function requestPort(host: string): string {
  return splitHostPort(host).port;
}

/** The request's `Host`, sanitized for inlining into a URL; IPv6 brackets survive. */
function requestHost(req: Request): string {
  const host = req.headers["host"] || "localhost";
  // Validate host header to prevent injection
  return host.replace(/[^\w.\-:\[\]]/g, "");
}

/** The request's own view of its address, used when no public origin is configured. */
function detectedBaseUrl(req: Request): string {
  // Trust x-forwarded-proto for protocol (safe — only affects URL scheme)
  // but use host header directly (not x-forwarded-host) to prevent open redirects
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = forwardedProto === "https" || req.secure ? "https" : "http";
  const sanitizedHost = requestHost(req);

  // Honour X-Forwarded-Port for proxies that strip the port from `Host` (e.g.
  // HTTPS on a non-443 port). Without it, manifest URLs default to :443 and iOS
  // cannot fetch the payload.
  if (!sanitizedHost.includes(":")) {
    const forwardedPort = req.headers["x-forwarded-port"];
    if (typeof forwardedPort === "string") {
      const port = forwardedPort.replace(/\D/g, "");
      const isDefault =
        (proto === "https" && port === "443") ||
        (proto === "http" && port === "80");
      if (port && !isDefault) {
        return `${proto}://${sanitizedHost}:${port}`;
      }
    }
  }

  return `${proto}://${sanitizedHost}`;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

/**
 * Appends an install ticket to a URL the device fetches itself: iOS opens these
 * as plain navigations (no access-token header), so they are guarded by the
 * signed exp+sig pair instead (see `middleware/accessAuth`). With no instance
 * password nothing is signed, those routes being open anyway.
 */
function signedInstallUrl(
  baseUrl: string,
  path: string,
  taskId: string,
): string {
  const url = joinUrl(baseUrl, path);
  const ticket = createInstallTicket(taskId);
  if (!ticket) return url;

  const params = new URLSearchParams({ exp: ticket.exp, sig: ticket.sig });
  return `${url}?${params}`;
}

// iOS rejects a package whose manifest disagrees with its bundle identifier;
// this only trips when a bare-app-id task failed to learn it from the package.
function canBuildManifest(task: { software: { bundleID: string } }): boolean {
  return Boolean(task.software.bundleID);
}

// Manifest plist for iTMS installation
router.get("/install/:id/manifest.plist", (req: Request, res: Response) => {
  const id = getIdParam(req);
  const task = getAllTasks().find(
    (t) => t.id === id && t.status === "completed",
  );

  if (!task || !task.filePath) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  if (!canBuildManifest(task)) {
    res.status(500).json({ error: "Bundle identifier unavailable" });
    return;
  }

  const baseUrl = getBaseUrl(req);
  // Each URL the manifest hands the device carries its own signed window, since
  // iOS fetches them without the access token.
  const payloadUrl = signedInstallUrl(
    baseUrl,
    `/api/install/${id}/payload.ipa`,
    id,
  );
  const smallIconUrl = signedInstallUrl(
    baseUrl,
    `/api/install/${id}/icon-small.png`,
    id,
  );
  const largeIconUrl = signedInstallUrl(
    baseUrl,
    `/api/install/${id}/icon-large.png`,
    id,
  );

  const manifest = buildManifest(
    task.software,
    payloadUrl,
    smallIconUrl,
    largeIconUrl,
  );

  res.setHeader("Content-Type", "application/xml");
  // The plist inlines the request's Host when no public origin is configured
  // (getBaseUrl) — never let a cache persist a Host-header-poisoned plist.
  res.setHeader("Cache-Control", "no-store");
  res.send(manifest);
});

router.get("/install/:id/url", (req: Request, res: Response) => {
  const id = getIdParam(req);
  const task = getAllTasks().find(
    (t) => t.id === id && t.status === "completed",
  );

  if (!task || !task.filePath) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  if (!canBuildManifest(task)) {
    res.status(500).json({ error: "Bundle identifier unavailable" });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const manifestUrl = signedInstallUrl(
    baseUrl,
    `/api/install/${id}/manifest.plist`,
    id,
  );
  const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(
    manifestUrl,
  )}`;

  res.json({ installUrl, manifestUrl });
});

// Stream IPA payload for installation
router.get("/install/:id/payload.ipa", (req: Request, res: Response) => {
  const id = getIdParam(req);
  const task = getAllTasks().find(
    (t) => t.id === id && t.status === "completed",
  );

  if (!task || !task.filePath || !fs.existsSync(task.filePath)) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  // Verify file path is within packages directory
  const packagesBase = path.resolve(path.join(config.dataDir, "packages"));
  const resolvedPath = path.resolve(task.filePath);
  if (!resolvedPath.startsWith(packagesBase + path.sep)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  res.setHeader("Content-Type", "application/octet-stream");
  const stats = fs.statSync(resolvedPath);
  res.setHeader("Content-Length", stats.size);

  const stream = fs.createReadStream(resolvedPath);
  // The read is anonymous and racy with a concurrent delete; without a listener
  // an ENOENT mid-stream would surface as a fatal unhandled 'error' event and
  // take the process down.
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(404).json({ error: "Package not found" });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
});

/**
 * Serves the icon the package carried, shown on the home screen while the app
 * installs. Both sizes draw from the same file — iOS scales, and a package is
 * unlikely to hold a 512x512 — and fall back to a blank image when there is none.
 */
router.get("/install/:id/icon-small.png", (req: Request, res: Response) => {
  sendInstallIcon(getIdParam(req), res);
});

router.get("/install/:id/icon-large.png", (req: Request, res: Response) => {
  sendInstallIcon(getIdParam(req), res);
});

function sendInstallIcon(id: string | undefined, res: Response): void {
  const task = id
    ? getAllTasks().find((t) => t.id === id && t.status === "completed")
    : undefined;
  const iconPath = task ? iconPathFor(task) : null;

  if (iconPath) {
    res.setHeader(
      "Content-Type",
      iconPath.endsWith(".jpg") ? "image/jpeg" : "image/png",
    );
    // Revalidated, not cached blind, so an older-format icon cannot stay stuck in
    // a cache it cannot be decoded from.
    res.setHeader("Cache-Control", "public, no-cache");
    res.sendFile(path.resolve(iconPath));
    return;
  }

  const png = getWhitePng();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", png.length);
  res.send(png);
}

export default router;
