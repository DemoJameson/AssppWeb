import { Router, Request, Response } from "express";
import {
  getVersionMetadataForApp,
  saveClientVersionMetadata,
  savePackageReadVersionMetadata,
} from "../services/versionMetadataCache.js";
import { versionMetadataFromDownloadURL } from "../services/packageVersionMetadata.js";

const router = Router();

// The shared version metadata cache. Reads are storefront-public (display
// version + release date), so no accountHash is required — `accessAuth` still
// gates it. Package-sourced entries stay authoritative (see services/versionMetadataCache.ts).
router.get("/version-metadata/:appId", (req: Request, res: Response) => {
  const raw = req.params.appId;
  const appId = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(appId)) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }

  res.json({ entries: getVersionMetadataForApp(appId) });
});

// Saves metadata a client fetched live from Apple. If a compiled package knows
// better the write is declined: `saved: false` with the authoritative entry.
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

/**
 * Reads one version's metadata out of its own package (`readVersionMetadataFromIPA`):
 * the download-product exchange dates the *app*, so every pinned version shares
 * one day. The URL comes from the client, so the result is saved as a
 * refreshable `package-read` entry that cannot displace the pipeline's `package`.
 */
router.post(
  "/version-metadata/:appId/:versionId/package",
  async (req: Request, res: Response) => {
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

    const body = (req.body ?? {}) as { downloadURL?: unknown };
    if (typeof body.downloadURL !== "string" || body.downloadURL === "") {
      res.status(400).json({ error: "downloadURL is required" });
      return;
    }

    try {
      const metadata = await versionMetadataFromDownloadURL(body.downloadURL);
      const result = savePackageReadVersionMetadata(
        appId,
        versionId,
        metadata.displayVersion,
        metadata.releaseDate,
      );
      if (!result.saved && !result.entry) {
        res.status(502).json({
          error: "Could not read the version from its package",
        });
        return;
      }

      res.json(result);
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not read the version from its package",
      });
    }
  },
);

export default router;
