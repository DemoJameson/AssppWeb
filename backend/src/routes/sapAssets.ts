// SAP asset routes: status/prepare for the extraction job and downloads of the
// five cached Apple binaries — public content, digest-pinned, same trust class
// as the bag proxy.

import { Router, Request, Response } from "express";
import zlib from "node:zlib";
import {
  SAP_ASSET_SPECS,
  ensureSapAssets,
  readBrotliSidecar,
  readCachedAsset,
  sapAssetsState,
} from "../services/sapAssets.js";

const router = Router();

router.get("/sap-assets/status", (_req: Request, res: Response) => {
  res.json(sapAssetsState());
});

router.post("/sap-assets/prepare", async (_req: Request, res: Response) => {
  try {
    // Fire-and-observe: the caller polls /status for progress.
    const preparation = ensureSapAssets();
    void preparation.catch(() => undefined);
    res.json(sapAssetsState());
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/sap-assets/:name", async (req: Request, res: Response) => {
  const name = req.params.name as string;
  const spec = SAP_ASSET_SPECS.find((candidate) => candidate.name === name);
  if (!spec) {
    res.status(404).json({ error: "Unknown SAP asset" });
    return;
  }

  // The digest is part of the URL so browser and Cache API entries are bound to
  // the bytes they were fetched for. A stale or missing pin is a caller error;
  // serving today's file under an old URL would make immutable caches unsafe.
  if (req.query.sha256 !== spec.strippedSha256) {
    res.status(409).json({ error: "SAP asset digest does not match" });
    return;
  }

  const encoding = preferredEncoding(req.headers["accept-encoding"]);
  const wantsCompression = dataOverCompressionThreshold(spec.strippedSize);
  const brotli =
    wantsCompression && encoding === "br"
      ? await readBrotliSidecar(name)
      : null;
  if (brotli) {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Content-Encoding", "br");
    res.setHeader("ETag", `"${spec.strippedSha256}-br"`);
    res.send(brotli);
    return;
  }

  let data = await readCachedAsset(name);
  if (!data) {
    try {
      await ensureSapAssets();
      data = await readCachedAsset(name);
    } catch (error) {
      res.status(503).json({
        error:
          error instanceof Error ? error.message : "SAP asset extraction failed",
      });
      return;
    }
  }
  if (!data) {
    res.status(503).json({ error: "SAP asset unavailable" });
    return;
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  // The representation (and therefore the ETag) depends on Accept-Encoding.
  res.setHeader("Vary", "Accept-Encoding");

  // gzip covers both a gzip preference and the fallback when br won the
  // negotiation but its sidecar was unavailable.
  if (
    wantsCompression &&
    (encoding === "gzip" || acceptsEncoding(req.headers["accept-encoding"], "gzip"))
  ) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("ETag", `"${spec.strippedSha256}-gzip"`);
    res.send(zlib.gzipSync(data, { level: 9 }));
    return;
  }
  res.setHeader("ETag", `"${spec.strippedSha256}"`);
  res.send(data);
});

function dataOverCompressionThreshold(size: number): boolean {
  return size > 65536;
}

function acceptsEncoding(header: string | undefined, name: string): boolean {
  if (!header) return false;
  for (const part of header.split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";");
    if (token !== name) continue;
    const q = params.find((param) => param.trim().startsWith("q="));
    const quality = q ? Number(q.trim().slice(2)) : 1;
    return Number.isFinite(quality) && quality > 0;
  }
  return false;
}

/** Chooses the highest-q supported encoding; ties go to Brotli because it is
 * smaller. Unknown encodings and q=0 are ignored. */
function preferredEncoding(header: string | undefined): "br" | "gzip" | null {
  if (!header) return null;
  let best: "br" | "gzip" | null = null;
  let bestQ = 0;
  for (const part of header.split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";");
    if (token !== "br" && token !== "gzip") continue;
    const q = params.find((param) => param.trim().startsWith("q="));
    const quality = q ? Number(q.trim().slice(2)) : 1;
    if (!Number.isFinite(quality) || quality <= 0) continue;
    if (
      quality > bestQ ||
      (quality === bestQ && token === "br")
    ) {
      best = token;
      bestQ = quality;
    }
  }
  return best;
}

export default router;
