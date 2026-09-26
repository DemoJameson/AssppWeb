import { Request, Response, NextFunction } from "express";
import { accessPasswordHash, verifyAccessToken } from "../config.js";
import {
  verifyDownloadTicket,
  verifyInstallTicket,
} from "../utils/downloadTicket.js";

/**
 * `GET /downloads/:id/icon` is drawn by an `<img>`, which cannot carry the access
 * token header. The image is public app artwork — the same file the install
 * manifest hands to iOS — and reaching a task still requires its id and account
 * hash, so it is exempt.
 */
const ICON_PATH_RE = /^\/downloads\/[^/]+\/icon$/;

/**
 * `GET /packages/:id/file` may be opened as a browser-native download, which —
 * like the icon — cannot attach the access-token header. Those links instead
 * carry a short-lived `exp`+`sig` pair issued by `GET /packages/:id/file-url`
 * (itself behind this middleware), scoped to the task and account hash.
 */
const DOWNLOAD_FILE_PATH_RE = /^\/packages\/([^/]+)\/file$/;

/**
 * The install routes are fetched by iOS out of a manifest, with no way to
 * attach the access token — the manifest itself included, since the
 * `itms-services://` link handed to the device is a plain navigation. They
 * carry the same kind of short-lived pair instead, issued by
 * `GET /install/:id/url` (itself behind this middleware) and scoped to the
 * task. `GET /install/:id/url` is deliberately *not* listed here: it is read by
 * the SPA, which does hold the token.
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
