import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createRateLimiter,
  rateLimitKey,
} from "../src/middleware/rateLimit.js";
import type { Request } from "express";

describe("rateLimitKey", () => {
  it("prefers req.ip and falls back to the socket address", () => {
    expect(rateLimitKey({ ip: "1.2.3.4" } as Request)).toBe("1.2.3.4");
    expect(
      rateLimitKey({
        socket: { remoteAddress: "5.6.7.8" },
      } as unknown as Request),
    ).toBe("5.6.7.8");
    expect(rateLimitKey({} as Request)).toBe("unknown");
  });
});

describe("createRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is allowed until the key has been hit the max number of times", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect(limiter.isAllowed("1.2.3.4")).toBe(true);
    limiter.hit("1.2.3.4");
    limiter.hit("1.2.3.4");
    expect(limiter.isAllowed("1.2.3.4")).toBe(true);
    limiter.hit("1.2.3.4");
    expect(limiter.isAllowed("1.2.3.4")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    limiter.hit("1.1.1.1");
    expect(limiter.isAllowed("1.1.1.1")).toBe(false);
    expect(limiter.isAllowed("2.2.2.2")).toBe(true);
  });

  it("resets the counter after the window elapses", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1 });

    limiter.hit("1.1.1.1");
    expect(limiter.isAllowed("1.1.1.1")).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(limiter.isAllowed("1.1.1.1")).toBe(true);
  });
});
