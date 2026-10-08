import { Request, Response, NextFunction } from "express";
import { accessPasswordHash, verifyAccessToken } from "../config.js";
import {
  verifyDownloadTicket,
  verifyInstallTicket,
} from "../utils/downloadTicket.js";

/**
 * `GET /downloads/:id/icon` is drawn by an `<img>`, which cannot carry the
 * access-token header. The image is public app artwork and reaching a task still
 * needs its id and account hash, so it is exempt.
 */
const ICON_PATH_RE = /^\/downloads\/[^/]+\/icon$/;

/**
 * `GET /packages/:id/file` may be opened as a browser-native download, which
 * cannot attach the token header; those links instead carry a short-lived
 * `exp`+`sig` pair issued by `GET /packages/:id/file-url` (itself behind this
 * middleware).
 */
const DOWNLOAD_FILE_PATH_RE = /^\/packages\/([^/]+)\/file$/;

/**
 * iOS fetches the install routes out of a manifest with no way to attach the
 * token — the manifest itself included, since the `itms-services://` link is a
 * plain navigation. They carry a short-lived pair issued by `GET /install/:id/url`
 * (itself behind this middleware); that URL is deliberately not listed — the SPA
 * holds the token and reads it.
 */
const INSTALL_PATH_RE =
  /^\/install\/([^/]+)\/(?:manifest\.plist|payload\.ipa|icon-small\.png|icon-large\.png)$/;

export function accessAuth(req: Request, res: Response, next: NextFunction) {
  if (!accessPasswordHash) {
    next();
    return;
  }

  if (
    req.path.startsWith("/auth/") ||
    ICON_PATH_RE.test(req.path)
  ) {
    next();
    return;
  }

  const token = req.headers["x-access-token"];
  if (typeof token === "string" && verifyAccessToken(token)) {
    next();
    return;
  }

  const fileMatch = DOWNLOAD_FILE_PATH_RE.exec(req.path);
  if (fileMatch) {
    const accountHash =
      typeof req.query.accountHash === "string" ? req.query.accountHash : "";
    const exp = typeof req.query.exp === "string" ? req.query.exp : "";
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (
      accountHash &&
      exp &&
      sig &&
      verifyDownloadTicket(fileMatch[1], accountHash, exp, sig)
    ) {
      next();
      return;
    }
  }

  const installMatch = INSTALL_PATH_RE.exec(req.path);
  if (installMatch) {
    const exp = typeof req.query.exp === "string" ? req.query.exp : "";
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (exp && sig && verifyInstallTicket(installMatch[1], exp, sig)) {
      next();
      return;
    }
  }

  res.status(401).json({ error: "Unauthorized" });
}
