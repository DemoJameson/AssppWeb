import { describe, it, expect, vi } from "vitest";
import { createHash, createHmac } from "crypto";

// Set the instance password before the module graph (and config.ts) loads.
process.env.ACCESS_PASSWORD = "download-ticket-test-password";

const { createDownloadTicket, verifyDownloadTicket } = await import(
  "../src/utils/downloadTicket.js"
);

const TASK = "task-123";
const HASH = "account-hash-abcdef";

describe("downloadTicket", () => {
  it("round-trips a freshly issued ticket", () => {
    const ticket = createDownloadTicket(TASK, HASH);
    expect(ticket).not.toBeNull();
    expect(
      verifyDownloadTicket(TASK, HASH, ticket!.exp, ticket!.sig),
    ).toBe(true);
  });

  it("rejects tickets for a different task or account", () => {
    const ticket = createDownloadTicket(TASK, HASH)!;
    expect(verifyDownloadTicket("other-task", HASH, ticket.exp, ticket.sig)).toBe(
      false,
    );
    expect(
      verifyDownloadTicket(TASK, "other-account-hash", ticket.exp, ticket.sig),
    ).toBe(false);
  });

  it("rejects tampered signatures and malformed expiries", () => {
    const ticket = createDownloadTicket(TASK, HASH)!;
    expect(
      verifyDownloadTicket(TASK, HASH, ticket.exp, "0".repeat(64)),
    ).toBe(false);
    expect(verifyDownloadTicket(TASK, HASH, "not-a-number", ticket.sig)).toBe(
      false,
    );
  });

  it("rejects expired tickets, even correctly signed ones", () => {
    const secret = createHash("sha256")
      .update("download-ticket-test-password")
      .digest("hex");
    const exp = String(Date.now() - 1000);
    const sig = createHmac("sha256", secret)
      .update(`${TASK}:${HASH}:${exp}`)
      .digest("hex");
    expect(verifyDownloadTicket(TASK, HASH, exp, sig)).toBe(false);
  });

  it("issues nothing when no instance password is set", async () => {
    vi.resetModules();
    delete process.env.ACCESS_PASSWORD;

    const fresh = await import("../src/utils/downloadTicket.js");
    expect(fresh.createDownloadTicket(TASK, HASH)).toBeNull();
    expect(fresh.verifyDownloadTicket(TASK, HASH, "123", "abc")).toBe(false);

    process.env.ACCESS_PASSWORD = "download-ticket-test-password";
  });
});
