import { Router, Request, Response } from "express";
import { findPackageAppByAppId } from "../services/packageAppStore.js";

const router = Router();

/**
 * What the package-app index knows about an app's builds — the platform each
 * compiled package belongs to, with the external version id the package
 * carried. Read-only and storefront-public (external version ids, no account
 * binding), like the version-pin store beside it.
 *
 * It answers a question the pins cannot: a pin holds one id per platform (the
 * newest one this instance downloaded), while the index holds *every* build
 * ever compiled here. A caller that has to rule out another platform's build —
 * the neighbour-id guess must never offer a tvOS build as a macOS pin — needs
 * all of them, not just the newest.
 */
router.get("/package-builds/:appId", (req: Request, res: Response) => {
  const raw = req.params.appId;
  const appId = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(appId)) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }

  const record = findPackageAppByAppId(appId);
  const builds = record
    ? Object.entries(record.builds).map(([platform, build]) => ({
        platform,
        versionId: build.externalVersionId,
        version: build.version,
      }))
    : [];

  res.json({ builds });
});

export default router;
