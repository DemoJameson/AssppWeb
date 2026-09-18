import { Router, Request, Response } from "express";
import { getVersionPinsForApp } from "../services/versionPinStore.js";

const router = Router();

// The recorded version-pin store, read-only by design: pins are seeded
// passively from packages the download pipeline compiled (no client writes, no
// credentials — see services/versionPinStore.ts). The data is
// storefront-public (external version ids, no account binding), so no
// accountHash is required; `accessAuth` still gates it like every other API
// route when the instance password is set.
router.get("/version-pins/:appId", (req: Request, res: Response) => {
  const raw = req.params.appId;
  const appId = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d+$/.test(appId)) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }

  res.json({ pins: getVersionPinsForApp(appId) });
});

export default router;
