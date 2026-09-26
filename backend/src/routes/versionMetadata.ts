import { Router, Request, Response } from "express";
import {
  getVersionMetadataForApp,
  saveClientVersionMetadata,
  savePackageReadVersionMetadata,
} from "../services/versionMetadataCache.js";
import { versionMetadataFromDownloadURL } from "../services/packageVersionMetadata.js";

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

/**
 * Reads one version's metadata out of its own package — ipatool's
 * `readVersionMetadataFromIPA`. The download-product exchange does report a
 * release date, but it dates the *app*: every pinned version of an app comes
 * back with the same day (and the `iTunesMetadata.plist` inside the download
 * says the same thing), which is how a picker ends up printing one date for
 * every row. The package is the per-build source of truth, as it already is for
 * compiled downloads.
 *
 * The client hands over the download URL it got from the pinned exchange; the
 * package is never fetched whole, and the URL is validated first like every
 * other package address.
 *
 * Reading a package does not make the result authoritative: the URL came from
 * the *client*, so the server cannot attest that the package behind it is the
 * build these ids name. It is therefore saved as a `package-read` entry — shown
 * as the build's date, since that is where the value came from, but refreshable
 * and unable to displace what the download pipeline compiled. `source =
 * 'package'` is reserved for the pipeline, which reads the package it built.
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
