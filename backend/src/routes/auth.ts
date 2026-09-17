import { Router, Request, Response } from "express";
import { config, accessPasswordHash, verifyAccessToken } from "../config.js";
import { createRateLimiter, rateLimitKey } from "../middleware/rateLimit.js";

const router = Router();

// The token can be brute-forced when an access password is set, so failed
// verifications are rate-limited per direct socket address. Only failures
// count: a correct login never consumes quota, so legitimate users cannot be
// locked out by other people's successful traffic. Ten failures per five
// minutes is far above what a human typing a password produces.
const verifyLimiter = createRateLimiter({
  windowMs: 5 * 60_000,
  max: 10,
});
const VERIFY_RATE_LIMIT_MESSAGE = "Too many attempts, try again later";

router.get("/auth/status", (_req: Request, res: Response) => {
  res.json({ required: config.accessPassword.length > 0 });
});

router.post("/auth/verify", (req: Request, res: Response) => {
  // No password configured — there is nothing to brute-force.
  if (!accessPasswordHash) {
    res.json({ ok: true });
    return;
  }

  const key = rateLimitKey(req);
  if (!verifyLimiter.isAllowed(key)) {
    res.status(429).json({ error: VERIFY_RATE_LIMIT_MESSAGE });
    return;
  }

  const { token } = req.body as { token?: string };
  if (!token || typeof token !== "string") {
    verifyLimiter.hit(key);
    res.json({ ok: false });
    return;
  }

  const ok = verifyAccessToken(token);
  if (!ok) verifyLimiter.hit(key);
  res.json({ ok });
});

export default router;
