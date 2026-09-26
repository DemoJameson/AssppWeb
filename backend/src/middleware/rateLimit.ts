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
 * Key a request by its client address.
 *
 * `X-Forwarded-For` is not read here — a client can forge it, and this app is
 * single-tenant with one shared access password. Behind a reverse proxy that
 * means every request arrives from the proxy's address, so all clients share a
 * bucket: the intended reading of "one tenant, one quota", but it also lets one
 * caller burn the quota and lock the real user out for a window. Express's
 * `trust proxy` setting is what resolves that — with it on, `req.ip` is the
 * client the proxy reports, and each caller gets its own bucket, at the cost of
 * trusting the proxy's word for it (see `TRUST_PROXY` in config.ts).
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

  /**
   * Drops every bucket whose window has closed.
   *
   * A bucket is created for each key the limiter is *asked* about, not only for
   * the ones that fail, so without this the map would keep one entry per address
   * that ever reached the route for the life of the process — an unbounded map
   * fed by the very endpoint that exists to bound traffic. The limiter guards
   * one login route, so a sweep per call is cheaper than a timer that has to be
   * owned and cleaned up.
   */
  function pruneExpired(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  function bucketFor(key: string): Bucket {
    const now = Date.now();
    pruneExpired(now);
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
