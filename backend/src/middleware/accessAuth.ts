import { Request, Response, NextFunction } from "express";
import { accessPasswordHash, verifyAccessToken } from "../config.js";

/**
 * `GET /downloads/:id/icon` is drawn by an `<img>`, which cannot carry the access
 * token header. The image is public app artwork — the very same file is already
 * served without a token under `/install/` for iOS — and reaching a task still
 * requires its id and account hash, so it is exempt.
 */
const ICON_PATH_RE = /^\/downloads\/[^/]+\/icon$/;

export function accessAuth(req: Request, res: Response, next: NextFunction) {
  if (!accessPasswordHash) {
    next();
    return;
  }

  if (
    req.path.startsWith("/auth/") ||
    req.path.startsWith("/install/") ||
    ICON_PATH_RE.test(req.path)
  ) {
    next();
    return;
  }

  const token = req.headers["x-access-token"];
  if (typeof token === "string" && verifyAccessToken(token)) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}
