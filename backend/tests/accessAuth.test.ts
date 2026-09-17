import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import type { Request, Response } from "express";

// Set the instance password before the module graph (and config.ts) loads.
process.env.ACCESS_PASSWORD = "access-auth-test-password";

const { accessAuth } = await import("../src/middleware/accessAuth.js");
const { createDownloadTicket } = await import(
  "../src/utils/downloadTicket.js"
);

const TOKEN = createHash("sha256")
  .update("access-auth-test-password")
  .digest("hex");

function run(req: {
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): { nextCalled: boolean; status?: number } {
  let nextCalled = false;
  let status: number | undefined;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
  } as unknown as Response;
  accessAuth(
    {
      path: req.path,
      headers: req.headers ?? {},
      query: req.query ?? {},
    } as unknown as Request,
    res,
    () => {
      nextCalled = true;
    },
  );
  return { nextCalled, status };
}

describe("accessAuth", () => {
  it("accepts the access token header", () => {
    expect(
      run({ path: "/downloads", headers: { "x-access-token": TOKEN } })
        .nextCalled,
    ).toBe(true);
  });

  it("rejects requests without a token", () => {
    const result = run({ path: "/downloads" });
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(401);
  });

  it("accepts a valid signed download link on the package file route", () => {
    const ticket = createDownloadTicket("task-1", "account-hash-1")!;
    const result = run({
      path: "/packages/task-1/file",
      query: {
        accountHash: "account-hash-1",
        exp: ticket.exp,
        sig: ticket.sig,
      },
    });
    expect(result.nextCalled).toBe(true);
  });

  it("does not honor signed links on other routes", () => {
    const ticket = createDownloadTicket("task-1", "account-hash-1")!;
    const result = run({
      path: "/packages",
      query: {
        accountHash: "account-hash-1",
        exp: ticket.exp,
        sig: ticket.sig,
      },
    });
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(401);
  });

  it("rejects a signed link with a wrong signature", () => {
    const result = run({
      path: "/packages/task-1/file",
      query: {
        accountHash: "account-hash-1",
        exp: String(Date.now() + 60_000),
        sig: "0".repeat(64),
      },
    });
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(401);
  });

  it("still exempts the icon route", () => {
    expect(run({ path: "/downloads/abc/icon" }).nextCalled).toBe(true);
  });
});
