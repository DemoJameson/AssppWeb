import { Router, Request, Response } from "express";
import { findPackageAppByAppId } from "../services/packageAppStore.js";

const router = Router();

/**
 * Every build the package-app index holds for an app (platform + external
 * version id), read-only and storefront-public. Unlike a pin (one id per
 * platform), this answers with *all* builds, so a caller can rule out another
 * platform's build.
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
