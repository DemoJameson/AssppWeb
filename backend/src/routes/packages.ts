import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { MIN_ACCOUNT_HASH_LENGTH } from "../config.js";
import { getAllTasks } from "../services/downloadManager.js";
import { getIdParam } from "../utils/route.js";
import { createDownloadTicket } from "../utils/downloadTicket.js";
import type { PackageInfo, Platform } from "../types/index.js";

const router = Router();

const PLATFORM_SUFFIX: Record<Platform, string> = {
  ios: "iOS",
  ipad: "iPadOS",
  tvos: "tvOS",
  visionos: "visionOS",
  macos: "macOS",
};

// File names that browsers will save verbatim: strip characters that are
// illegal on common filesystems; the header itself is encoded by
// `res.download` (RFC 5987), so Unicode names survive intact.
export function packageDownloadName(
  name: string,
  version: string,
  platform?: Platform,
): string {
  const suffix = platform ? PLATFORM_SUFFIX[platform] : "iOS";
  const base = `${name}_${version}_${suffix}`
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "-")
    .slice(0, 170);
  return `${base}${packageDownloadExtension(platform)}`;
}

/**
 * The extension that says what the file is: every package this pipeline
 * compiles is an IPA, except Apple's macOS ones, which arrive — and install —
 * as `.pkg` containers. A macOS download saved as `.ipa` is a file the Mac
 * will refuse to open, whatever its bytes are.
 */
export function packageDownloadExtension(platform?: Platform): string {
  return platform === "macos" ? ".pkg" : ".ipa";
}

// List packages filtered by account hashes
router.get("/packages", (req: Request, res: Response) => {
  const hashesParam = req.query.accountHashes;
  if (!hashesParam || typeof hashesParam !== "string") {
    res.json([]);
    return;
  }
  const hashes = new Set(hashesParam.split(",").filter(Boolean));
  if (hashes.size === 0) {
    res.json([]);
    return;
  }

  const packages: Omit<PackageInfo, "filePath">[] = [];
  const completedTasks = getAllTasks().filter(
    (t) => t.status === "completed" && t.filePath && hashes.has(t.accountHash),
  );

  for (const task of completedTasks) {
    if (!task.filePath || !fs.existsSync(task.filePath)) continue;

    const stats = fs.statSync(task.filePath);
    packages.push({
      id: task.id,
      software: task.software,
      accountHash: task.accountHash,
      fileSize: stats.size,
      createdAt: task.createdAt,
    });
  }

  res.json(packages);
});

// Issues the URL a browser-native download should open for the file below.
// Safe to navigate to without headers: when the instance password is set, the
// URL carries a short-lived exp+sig pair instead of the access token.
router.get("/packages/:id/file-url", (req: Request, res: Response) => {
  const accountHash = req.query.accountHash as string;
  if (!accountHash || accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
    res.status(400).json({ error: "Missing or invalid accountHash" });
    return;
  }

  const id = getIdParam(req) ?? "";
  const task = getAllTasks().find(
    (t) => t.id === id && t.status === "completed",
  );

  if (!task || !task.filePath || !fs.existsSync(task.filePath)) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  if (task.accountHash !== accountHash) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const params = new URLSearchParams({ accountHash });
  const ticket = createDownloadTicket(id, accountHash);
  if (ticket) {
    params.set("exp", ticket.exp);
    params.set("sig", ticket.sig);
  }

  res.json({ url: `/api/packages/${encodeURIComponent(id)}/file?${params}` });
});

// Stream IPA file (requires accountHash; accessAuth also accepts signed links)
router.get("/packages/:id/file", (req: Request, res: Response) => {
  const accountHash = req.query.accountHash as string;
  if (!accountHash || accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
    res.status(400).json({ error: "Missing or invalid accountHash" });
    return;
  }

  const id = getIdParam(req);
  const task = getAllTasks().find(
    (t) => t.id === id && t.status === "completed",
  );

  if (!task || !task.filePath || !fs.existsSync(task.filePath)) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  if (task.accountHash !== accountHash) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // Verify file path is within packages directory
  const packagesBase = path.resolve(path.join(config.dataDir, "packages"));
  const resolvedPath = path.resolve(task.filePath);
  if (!resolvedPath.startsWith(packagesBase + path.sep)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // res.download streams with Range support (downloads can pause and resume)
  // and encodes the filename per RFC 5987, so Unicode names survive intact.
  const fileName = packageDownloadName(
    task.software.name,
    task.software.version,
    task.software.platform,
  );
  res.download(resolvedPath, fileName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "Failed to send package" });
    }
  });
});

// Delete a package (requires accountHash)
router.delete("/packages/:id", (req: Request, res: Response) => {
  const accountHash = req.query.accountHash as string;
  if (!accountHash || accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
    res.status(400).json({ error: "Missing or invalid accountHash" });
    return;
  }

  const id = getIdParam(req);
  const packagesDir = path.join(config.dataDir, "packages");
  const packagesBase = path.resolve(packagesDir);

  const task = getAllTasks().find((t) => t.id === id);
  if (!task || !task.filePath) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  if (task.accountHash !== accountHash) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // Verify file path is within packages directory
  const resolvedPath = path.resolve(task.filePath);
  if (!resolvedPath.startsWith(packagesBase + path.sep)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (fs.existsSync(resolvedPath)) {
    fs.unlinkSync(resolvedPath);

    // Clean up empty parent directories
    let dir = path.dirname(resolvedPath);
    while (dir !== packagesBase && dir.startsWith(packagesBase)) {
      const contents = fs.readdirSync(dir);
      if (contents.length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    }
  }

  res.json({ success: true });
});

export default router;
