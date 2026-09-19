import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { accountSelectLabel } from "../../src/utils/account";
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
