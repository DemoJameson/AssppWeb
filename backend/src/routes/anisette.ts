import { Router, type Request, type Response, type NextFunction } from "express";
import {
  AnisetteUnavailableError,
  anisetteStatus,
  prepareAnisette,
  requestAuthAction,
  requestAuthHeaders,
  requestStoreProof,
} from "../services/anisette.js";
import { createRateLimiter, rateLimitKey } from "../middleware/rateLimit.js";

const router = Router();

// These endpoints are expensive: a headers/action call can start a full GSA
// machine provisioning, and the helper serializes all proofs. accessAuth is
// optional, so a public instance needs its own per-IP budget.
const prepareLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10 });
const authLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 30 });
// Version-history backfill can legitimately request up to a hundred metadata
// proofs, so this budget is deliberately looser than the auth endpoints.
const proofLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 300 });
const RATE_LIMIT_MESSAGE = "Too many device-verification requests, try again later";

/** The only identity headers the helper may forward to Apple's provisioning endpoint. */
const IDENTITY_HEADERS = new Set([
  "x-apple-i-client-time",
  "x-apple-i-md-lu",
  "x-apple-i-srl-no",
  "x-apple-i-timezone",
  "x-apple-locale",
  "x-mme-device-id",
  "x-mme-client-info",
]);

router.get("/anisette/status", (_req: Request, res: Response) => {
  res.json(anisetteStatus());
});

router.post(
  "/anisette/prepare",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!allow(prepareLimiter, req, res)) return;

    try {
      await prepareAnisette();
      res.json({ ready: true });
    } catch (error) {
      sendHelperError(res, next, error);
    }
  },
);

router.post(
  "/anisette/auth/headers",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!allow(authLimiter, req, res)) return;

    const deviceIdentifier = stringField(req.body, "deviceIdentifier");
    if (!deviceIdentifier) {
      res.status(400).json({ error: "deviceIdentifier is required" });
      return;
    }

    try {
      res.json(
        await requestAuthHeaders(
          deviceIdentifier,
          stringField(req.body, "state") ?? "",
          stringField(req.body, "authEndpoint") ?? "",
          machineFamily(stringField(req.body, "family")),
        ),
      );
    } catch (error) {
      sendHelperError(res, next, error);
    }
  },
);

router.post(
  "/anisette/auth/action",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!allow(authLimiter, req, res)) return;

    const deviceIdentifier = stringField(req.body, "deviceIdentifier");
    const state = stringField(req.body, "state");
    const action = stringField(req.body, "action");
    const authEndpoint = stringField(req.body, "authEndpoint");
    if (!deviceIdentifier || !state || !action || !authEndpoint) {
      res.status(400).json({
        error:
          "deviceIdentifier, state, action and authEndpoint are required",
      });
      return;
    }

    try {
      res.json(
        await requestAuthAction(
          deviceIdentifier,
          state,
          action,
          stringField(req.body, "data") ?? "",
          authEndpoint,
          stringRecord(req.body?.identityHeaders),
          {
            family: machineFamily(stringField(req.body, "family")),
            finishUrl: stringField(req.body, "finishUrl"),
          },
        ),
      );
    } catch (error) {
      sendHelperError(res, next, error);
    }
  },
);

router.post(
  "/anisette/store/proof",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!allow(proofLimiter, req, res)) return;

    const deviceIdentifier = stringField(req.body, "deviceIdentifier");
    const state = stringField(req.body, "state");
    const endpoint = stringField(req.body, "endpoint");
    if (!deviceIdentifier || !state || !endpoint) {
      res.status(400).json({
        error: "deviceIdentifier, state and endpoint are required",
      });
      return;
    }

    try {
      res.json(
        await requestStoreProof(
          deviceIdentifier,
          state,
          endpoint,
          machineFamily(stringField(req.body, "family")),
        ),
      );
    } catch (error) {
      sendHelperError(res, next, error);
    }
  },
);

function sendHelperError(
  res: Response,
  next: NextFunction,
  error: unknown,
): void {
  if (error instanceof AnisetteUnavailableError) {
    res.status(503).json({ error: error.message });
    return;
  }

  if (error instanceof Error) {
    res.status(502).json({ error: error.message });
    return;
  }

  next(error);
}

function allow(
  limiter: ReturnType<typeof createRateLimiter>,
  req: Request,
  res: Response,
): boolean {
  const key = rateLimitKey(req);
  if (!limiter.isAllowed(key)) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return false;
  }

  limiter.hit(key);
  return true;
}

function stringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      IDENTITY_HEADERS.has(key.toLowerCase()) &&
      typeof entry === "string" &&
      key.length <= 128 &&
      entry.length <= 8192
    ) {
      out[key] = entry;
    }
    if (Object.keys(out).length >= IDENTITY_HEADERS.size) break;
  }
  return out;
}

function machineFamily(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "amd" || normalized === "md" ? normalized : undefined;
}

export default router;
