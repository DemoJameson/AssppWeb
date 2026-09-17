import { Request, Response, NextFunction } from "express";

/**
 * Static security response headers. Values are fixed server-side constants —
 * nothing is derived from request headers (see the AGENTS.md rule on the
 * settings endpoint and header reflection).
 *
 * CSP is deliberately absent: the SPA loads libcurl.js WASM, spawns blob
 * workers, and hands `itms-services://` links to iOS, all of which a naive
 * policy would break.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
}
