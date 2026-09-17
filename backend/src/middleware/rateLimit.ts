import { Request } from "express";

interface RateLimitOptions {
  /** Fixed window length in milliseconds. */
  windowMs: number;
  /** Max recorded hits per window per key. */
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Key a request by its direct socket address.
 *
 * `X-Forwarded-For` is deliberately NOT consulted: a client can forge it, and
 * this app is single-tenant (one shared access password), so requests sharing
 * a reverse proxy's IP sharing one bucket is the intended behavior.
 */
export function rateLimitKey(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * In-memory fixed-window rate limiter. The caller decides what counts as a
 * hit — the auth route only records failed verifications, so successful
 * logins never consume quota.
 */
export function createRateLimiter({ windowMs, max }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  function bucketFor(key: string): Bucket {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  return {
    /** Whether the key is still under the limit. Does not record a hit. */
    isAllowed(key: string): boolean {
      return bucketFor(key).count < max;
    },

    /** Record one hit against the key. */
    hit(key: string): void {
      bucketFor(key).count++;
    },
  };
}
