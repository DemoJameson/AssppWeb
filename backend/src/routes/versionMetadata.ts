import { Router, Request, Response } from "express";
import {
  getVersionMetadataForApp,
  saveClientVersionMetadata,
} from "../services/versionMetadataCache.js";

const router = Router();

// The shared version metadata cache. Reads are storefront-public (display
// version + release date, no account binding), so no accountHash is required;
// `accessAuth` still gates it like every other API route when the instance
// password is set. Writes accept metadata a client fetched live from Apple —
// package-sourced entries stay authoritative, see services/versionMetadataCache.ts.
router.get("/version-metadata/:appId", (req: Request, res: Response) => {
  const raw = req.params.appId;
  const appId = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(appId)) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }

  res.json({ entries: getVersionMetadataForApp(appId) });
});

// Saves metadata a client fetched live from Apple. When a compiled package
// already knows better the write is declined: `saved: false` comes back with
// the entry that remains authoritative.
router.put(
  "/version-metadata/:appId/:versionId",
  (req: Request, res: Response) => {
    const rawAppId = req.params.appId;
    const rawVersionId = req.params.versionId;
    const appId = Array.isArray(rawAppId) ? rawAppId[0] : rawAppId;
    const versionId = Array.isArray(rawVersionId)
      ? rawVersionId[0]
      : rawVersionId;
    if (!/^\d+$/.test(appId) || !/^\d+$/.test(versionId)) {
      res.status(400).json({ error: "Invalid app or version id" });
      return;
    }

    const body = (req.body ?? {}) as {
      displayVersion?: unknown;
      releaseDate?: unknown;
    };
    if (
      typeof body.displayVersion !== "string" ||
      typeof body.releaseDate !== "string"
    ) {
      res
        .status(400)
        .json({ error: "displayVersion and releaseDate are required" });
      return;
    }

    const result = saveClientVersionMetadata(
      appId,
      versionId,
      body.displayVersion,
      body.releaseDate,
    );
    if (!result.saved && !result.entry) {
      res.status(400).json({ error: "Invalid version metadata" });
      return;
    }

    res.json(result);
  },
);

export default router;
