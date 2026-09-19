import type { TFunction } from "i18next";
import type { Account } from "../types";
import { accountSelectLabel } from "./account";

export interface AccountContext {
  account: string;
}

/**
 * Extract display-friendly account context for toast notifications.
 * The label matches the account dropdown format (region · name (email)).
 */
export function getAccountContext(
  account: Account | undefined,
  t: TFunction,
): AccountContext {
  if (!account) {
    return { account: "Unknown" };
  }
  return { account: accountSelectLabel(account, t) };
}
