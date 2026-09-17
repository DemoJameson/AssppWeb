import { Router, Request, Response } from "express";
import { getVersionMetadataForApp } from "../services/versionMetadataCache.js";

const router = Router();

// The shared version metadata cache, read-only by design: entries are seeded
// passively from packages the download pipeline compiled (no client writes, no
// credentials — see services/versionMetadataCache.ts). The data is
// storefront-public (display version + release date, no account binding), so
// no accountHash is required; `accessAuth` still gates it like every other
// API route when the instance password is set.
router.get("/version-metadata/:appId", (req: Request, res: Response) => {
  const raw = req.params.appId;
  const appId = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(appId)) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }

  res.json({ entries: getVersionMetadataForApp(appId) });
});

export default router;
