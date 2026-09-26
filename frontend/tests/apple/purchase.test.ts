import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { purchaseApp, PurchaseError } from "../../src/apple/purchase";
import { appleRequest } from "../../src/apple/request";
import i18n from "../../src/i18n";
import type { Account, Software } from "../../src/types";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

const account: Account = {
  email: "test@example.com",
  password: "secret",
  appleId: "test@example.com",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token",
  directoryServicesIdentifier: "1234567890",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
  pod: "25",
};

const freeApp = { id: 1492142120, bundleID: "com.example.app", name: "Example", price: 0 } as Software;

type Reply = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: [string, string][];
  body: string;
};

const reply = (body: string, status = 200): Reply => ({
  status,
  statusText: String(status),
  headers: {},
  rawHeaders: [],
  body,
});

const successDoc = () => buildPlist({ jingleDocType: "purchaseSuccess", status: 0 });

const failureDoc = (failureType: string, customerMessage?: string) =>
  buildPlist({ failureType, ...(customerMessage ? { customerMessage } : {}) });

type RequestOptions = { host: string; path: string; body?: string };

let replies: Reply[] = [];

const calls = () => vi.mocked(appleRequest).mock.calls.map((call) => call[0] as RequestOptions);

describe("apple/purchase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replies = [];

    vi.mocked(appleRequest).mockImplementation(async () => {
      const next = replies.shift();
      if (!next) {
        throw new Error("unexpected extra purchase request");
      }
      return next;
    });
  });

  it("posts buyProduct to the pod host with the account's token", async () => {
    replies = [reply(successDoc())];

    await purchaseApp(account, freeApp);

    expect(calls()).toHaveLength(1);
    expect(calls()[0].host).toBe("p25-buy.itunes.apple.com");
    expect(calls()[0].path).toContain("/buyProduct");
    expect(calls()[0].body).toContain('<key>pricingParameters</key><string>STDQ</string>');
  });

  it("refuses paid apps without asking Apple", async () => {
    await expect(purchaseApp(account, { ...freeApp, price: 1999 } as Software)).rejects.toThrow(
      i18n.t("errors.purchase.paidNotSupported"),
    );
    expect(calls()).toHaveLength(0);
  });

  it.each([["5002"], ["2019"]])(
    "treats %s (the account already owns the app) as success",
    async (failureType) => {
      replies = [reply(failureDoc(failureType, "An unknown error has occurred"))];

      await expect(purchaseApp(account, freeApp)).resolves.toBeDefined();
      expect(calls()).toHaveLength(1);
    },
  );

  it("treats an HTTP 500 without a failureType as an already-fulfilled order", async () => {
    // ipatool maps a 500 from buyProduct to ErrLicenseAlreadyExists, which its
    // CLI ignores as a terminal success state.
    replies = [reply(buildPlist({ customerMessage: "" }), 500)];

    await expect(purchaseApp(account, freeApp)).resolves.toBeDefined();
    expect(calls()).toHaveLength(1);
  });

  it.each([
    ["an empty body", ""],
    ["a body that is not a plist", "<html><body>Internal Server Error</body></html>"],
  ])("reads a 500 with %s as the same already-fulfilled order", async (_label, body) => {
    // The status is the answer here, so parsing the body must not be able to
    // pre-empt it — an empty one used to throw out of the plist parser.
    replies = [reply(body, 500)];

    await expect(purchaseApp(account, freeApp)).resolves.toBeDefined();
    expect(calls()).toHaveLength(1);
  });

  it("retries with the Apple Arcade pricing parameter when the item is unavailable", async () => {
    replies = [reply(failureDoc("2059")), reply(successDoc())];

    await purchaseApp(account, freeApp);

    const sent = calls();
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toContain('<key>pricingParameters</key><string>STDQ</string>');
    expect(sent[1].body).toContain('<key>pricingParameters</key><string>GAME</string>');
  });

  it("does not retry a failure that is not the unavailable one", async () => {
    replies = [reply(failureDoc("5002"))];

    await purchaseApp(account, freeApp);

    expect(calls()).toHaveLength(1);
  });

  it.each([["2034"], ["2042"]])("reports %s as an expired session", async (failureType) => {
    replies = [reply(failureDoc(failureType))];

    const error = await purchaseApp(account, freeApp).catch((e: PurchaseError) => e);

    expect(error).toBeInstanceOf(PurchaseError);
    expect((error as PurchaseError).code).toBe(failureType);
  });

  it("reports Apple's message for an unmapped failure", async () => {
    replies = [reply(failureDoc("startupFailure", "This item is not available"))];

    await expect(purchaseApp(account, freeApp)).rejects.toThrow(/This item is not available/);
  });

  it("fails when Apple answers without a purchase confirmation", async () => {
    replies = [reply(buildPlist({ jingleDocType: "purchaseFailure", status: 1 }))];

    await expect(purchaseApp(account, freeApp)).rejects.toThrow(
      i18n.t("errors.purchase.failedGeneral"),
    );
  });
});
