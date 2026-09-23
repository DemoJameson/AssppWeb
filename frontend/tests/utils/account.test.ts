import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import {
  accountHardwareId,
  accountSelectLabel,
  packageAccountLabel,
} from "../../src/utils/account";
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

  it("leaves out a name the account does not carry", () => {
    // An account with no name on it is its address alone — no empty pair of
    // brackets, and no separator introducing nothing.
    expect(
      accountSelectLabel({ ...account, firstName: "", lastName: "" }, t),
    ).toBe("JP · demo@example.test");
  });

  it("still names an account whose storefront is unknown", () => {
    expect(accountSelectLabel({ ...account, store: "" }, t)).toBe(
      "Demo User (demo@example.test)",
    );
  });
});

describe("packageAccountLabel", () => {
  it("names the account the way the pickers name it", () => {
    // A download is told apart by whose it is, and the row has to say that in
    // the same words the account select offers — one account, one name.
    expect(packageAccountLabel(account, "123456789", t)).toBe(
      "JP · Demo User (demo@example.test)",
    );
  });

  it("falls back to what the record still carries once the account is gone", () => {
    // A package outlives the account it was downloaded with, so the row says
    // the key that package is filed under rather than nothing at all.
    expect(packageAccountLabel(undefined, "abc123hash", t)).toBe("abc123hash");
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
