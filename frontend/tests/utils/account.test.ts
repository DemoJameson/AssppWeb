import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { accountHardwareId, accountSelectLabel } from "../../src/utils/account";
import type { Account } from "../../src/types";

const t = ((_key: string, fallback?: string) =>
  fallback ?? _key) as unknown as TFunction;

const account: Account = {
  email: "demo@example.test",
  password: "test-password",
  appleId: "demo@example.test",
  store: "143462",
  firstName: "Demo",
  lastName: "User",
  passwordToken: "test-token",
  directoryServicesIdentifier: "123456789",
  cookies: [],
  deviceIdentifier: "001122aabbcc",
};

describe("accountSelectLabel", () => {
  it("joins the country and the name with a middle dot", () => {
    expect(accountSelectLabel(account, t)).toBe(
      "JP · Demo User (demo@example.test)",
    );
  });
});

describe("accountHardwareId", () => {
  it("hands back the device id the download was requested with", () => {
    // The `guid` Apple is told and the hardware id StoreAgent derives its key
    // from are the same bytes, so the id travels as it is.
    expect(accountHardwareId(account)).toBe("001122aabbcc");
  });

  it("refuses an id that is not hex", () => {
    // An imported serial number cannot be the hardware id a macOS package is
    // decrypted with, and the caller has to say so before fetching a package
    // nothing could open.
    expect(accountHardwareId({ ...account, deviceIdentifier: "C02XK1AB" })).toBeUndefined();
    expect(accountHardwareId({ ...account, deviceIdentifier: "" })).toBeUndefined();
    expect(accountHardwareId({ ...account, deviceIdentifier: "abc" })).toBeUndefined();
  });
});
