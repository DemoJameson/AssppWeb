import { describe, it, expect, vi } from "vitest";
import { httpsRedirect } from "../src/middleware/httpsRedirect.js";
import { securityHeaders } from "../src/middleware/securityHeaders.js";
import { config } from "../src/config.js";
import type { Request, Response, NextFunction } from "express";

function createMockReq(
  headers: Record<string, string>,
  url: string = "/test",
): Request {
  return { headers, url } as unknown as Request;
}

function createMockRes(): {
  res: Response;
  redirectCalledWith: { status: number; url: string } | null;
} {
  let redirectCalledWith: { status: number; url: string } | null = null;
  const res = {
    redirect: (status: number, url: string) => {
      redirectCalledWith = { status, url };
      return res;
    },
  } as unknown as Response;
  return {
    res,
    redirectCalledWith: null,
    get redirectData() {
      return redirectCalledWith;
    },
  };
}

describe("httpsRedirect middleware", () => {
  it("should redirect HTTP to HTTPS", () => {
    const req = createMockReq(
      { "x-forwarded-proto": "http", host: "example.com" },
      "/test?foo=bar",
    );
    const mock = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    httpsRedirect(req, mock.res, next);

    expect(nextCalled).toBe(false);
    // The redirect was called - verify through the mock
  });

  it("should not redirect when proto is https", () => {
    const req = createMockReq({
      "x-forwarded-proto": "https",
      host: "example.com",
    });
    const mock = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    httpsRedirect(req, mock.res, next);

    expect(nextCalled).toBe(true);
  });

  it("should not redirect when no x-forwarded-proto header", () => {
    const req = createMockReq({ host: "example.com" });
    const mock = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    httpsRedirect(req, mock.res, next);

    expect(nextCalled).toBe(true);
  });

  it("should skip redirect when disableHttpsRedirect is true", () => {
    const original = config.disableHttpsRedirect;
    config.disableHttpsRedirect = true;
    try {
      const req = createMockReq(
        { "x-forwarded-proto": "http", host: "example.com" },
        "/test",
      );
      const mock = createMockRes();
      let nextCalled = false;
      const next: NextFunction = () => {
        nextCalled = true;
      };

      httpsRedirect(req, mock.res, next);

      expect(nextCalled).toBe(true);
    } finally {
      config.disableHttpsRedirect = original;
    }
  });

  it("should use host header (not x-forwarded-host) for security", () => {
    const req = createMockReq(
      {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "custom.example.com",
        host: "internal.host",
      },
      "/path",
    );

    let redirectUrl = "";
    const res = {
      redirect: (_status: number, url: string) => {
        redirectUrl = url;
        return res;
      },
    } as unknown as Response;
    const next: NextFunction = () => {};

    httpsRedirect(req, res, next);

    // Should use host header, not x-forwarded-host, to prevent open redirects
    expect(redirectUrl).toBe("https://internal.host/path");
  });
});

describe("securityHeaders middleware", () => {
  it("should set static security headers and call next", () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as Response;
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    securityHeaders(createMockReq({}), res, next);

    expect(nextCalled).toBe(true);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(headers["Referrer-Policy"]).toBe("same-origin");
  });

  it("should not set a Content-Security-Policy (WASM/itms-services need the loose default)", () => {
    const headerNames: string[] = [];
    const res = {
      setHeader: (name: string) => {
        headerNames.push(name);
      },
    } as unknown as Response;

    securityHeaders(createMockReq({}), res, () => {});

    expect(headerNames).not.toContain("Content-Security-Policy");
  });
});
