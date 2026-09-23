import type { TFunction } from "i18next";
import { storeIdToCountry } from "../apple/config";
import type { Account } from "../types";

function normalizeStorefront(store?: string): string | undefined {
  if (!store) return undefined;
  const [storeId] = store.split("-");
  return storeId || undefined;
}

export function accountStoreCountry(
  account?: Account | null,
): string | undefined {
  const storeId = normalizeStorefront(account?.store);
  if (!storeId) return undefined;
  return storeIdToCountry(storeId);
}

export function firstAccountCountry(accounts: Account[]): string | undefined {
  for (const account of accounts) {
    const country = accountStoreCountry(account);
    if (country) return country;
  }
  return undefined;
}

/**
 * The one name an account goes by, wherever it is offered or reported: the
 * storefront, then the person, then the address — `JP · Demo User
 * (demo@example.test)`. Parts an account does not have are left out rather than
 * left blank: an account with no name on it is its address alone, and one with
 * no storefront known is named without the separator that would introduce it.
 */
export function accountSelectLabel(account: Account, t: TFunction): string {
  const cc = accountStoreCountry(account);
  const countryLabel = cc ? t(`countries.${cc}`, cc) : "";
  const name = `${account.firstName} ${account.lastName}`.trim();
  const person = name ? `${name} (${account.email})` : account.email;
  return [countryLabel, person].filter(Boolean).join(" · ");
}

/**
 * How a package names the account it was downloaded with: the same label the
 * account pickers offer (`storefront · name (email)`), so a download list row
 * and the package detail page call one account by one name. `fallback` is what
 * is left to say when that account is gone — the record's own key (its hash),
 * or a preview row's own name.
 */
export function packageAccountLabel(
  account: Account | undefined,
  fallback: string,
  t: TFunction,
): string {
  return account ? accountSelectLabel(account, t) : fallback;
}

export async function accountHash(account: Account): Promise<string> {
  const source =
    account.directoryServicesIdentifier || account.appleId || account.email;
  return sha256Hex(source);
}

/** A device id as Apple's `guid` carries it: an even number of hex digits. */
const HARDWARE_ID_RE = /^([0-9a-fA-F]{2})+$/;

/**
 * The hardware id a download is requested with (`guid`), in the hex form the
 * macOS decrypter reads it in — the two are the same bytes, one hex-encoded
 * the other raw, and StoreAgent derives its key from them. `undefined` when the
 * account carries something that is not a hex id (an imported serial number,
 * say): a macOS package could not be decrypted with it, and the caller says so
 * rather than fetching a package nothing can open.
 */
export function accountHardwareId(account: Account): string | undefined {
  const id = account.deviceIdentifier;
  return typeof id === "string" && HARDWARE_ID_RE.test(id) ? id : undefined;
}

async function sha256Hex(value: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const data = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(digest));
  }

  return fnv1a64Hex(value);
}

function fnv1a64Hex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
