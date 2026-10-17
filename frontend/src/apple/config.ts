export const userAgent =
  "Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6";

export const countryCodeMap: Record<string, string> = {
  AE: "143481",
  AG: "143540",
  AI: "143538",
  AL: "143575",
  AM: "143524",
  AO: "143564",
  AR: "143505",
  AT: "143445",
  AU: "143460",
  AZ: "143568",
  BB: "143541",
  BD: "143490",
  BE: "143446",
  BG: "143526",
  BH: "143559",
  BM: "143542",
  BN: "143560",
  BO: "143556",
  BR: "143503",
  BS: "143539",
  BW: "143525",
  BY: "143565",
  BZ: "143555",
  CA: "143455",
  CH: "143459",
  CI: "143527",
  CL: "143483",
  CN: "143465",
  CO: "143501",
  CR: "143495",
  CY: "143557",
  CZ: "143489",
  DE: "143443",
  DK: "143458",
  DM: "143545",
  DO: "143508",
  DZ: "143563",
  EC: "143509",
  EE: "143518",
  EG: "143516",
  ES: "143454",
  FI: "143447",
  FR: "143442",
  GB: "143444",
  GD: "143546",
  GE: "143615",
  GH: "143573",
  GR: "143448",
  GT: "143504",
  GY: "143553",
  HK: "143463",
  HN: "143510",
  HR: "143494",
  HU: "143482",
  ID: "143476",
  IE: "143449",
  IL: "143491",
  IN: "143467",
  IS: "143558",
  IT: "143450",
  IQ: "143617",
  JM: "143511",
  JO: "143528",
  JP: "143462",
  KE: "143529",
  KN: "143548",
  KR: "143466",
  KW: "143493",
  KY: "143544",
  KZ: "143517",
  LB: "143497",
  LC: "143549",
  LI: "143522",
  LK: "143486",
  LT: "143520",
  LU: "143451",
  LV: "143519",
  MD: "143523",
  MG: "143531",
  MK: "143530",
  ML: "143532",
  MN: "143592",
  MO: "143515",
  MS: "143547",
  MT: "143521",
  MU: "143533",
  MV: "143488",
  MX: "143468",
  MY: "143473",
  NE: "143534",
  NG: "143561",
  NI: "143512",
  NL: "143452",
  NO: "143457",
  NP: "143484",
  NZ: "143461",
  OM: "143562",
  PA: "143485",
  PE: "143507",
  PH: "143474",
  PK: "143477",
  PL: "143478",
  PT: "143453",
  PY: "143513",
  QA: "143498",
  RO: "143487",
  RS: "143500",
  RU: "143469",
  SA: "143479",
  SE: "143456",
  SG: "143464",
  SI: "143499",
  SK: "143496",
  SN: "143535",
  SR: "143554",
  SV: "143506",
  TC: "143552",
  TH: "143475",
  TN: "143536",
  TR: "143480",
  TT: "143551",
  TW: "143470",
  TZ: "143572",
  UA: "143492",
  UG: "143537",
  US: "143441",
  UY: "143514",
  UZ: "143566",
  VC: "143550",
  VE: "143502",
  VG: "143543",
  VN: "143471",
  YE: "143571",
  ZA: "143472",
};

/**
 * Apple accounts in China mainland and India may sign in with a phone number
 * (support.apple.com/en-hk/105034). Such an ID names no storefront, so Apple
 * needs X-Apple-Store-Front to send the code (see ipatool authStoreFront).
 *
 * Only the separators Apple accepts are removed: ASCII spaces and hyphens.
 * Anything else in the number rejects the hint, so a legacy username that
 * happens to contain digits cannot be mistaken for a phone account.
 */
export function authStoreFront(identifier: string): string {
  let number = identifier.trim().replace(/ /g, "").replace(/-/g, "");
  let international = false;

  if (number.startsWith("+")) {
    international = true;
    number = number.slice(1);
  } else if (number.startsWith("00")) {
    international = true;
    number = number.slice(2);
  }

  if (!/^[0-9]*$/.test(number)) return "";

  // Check the full length before removing a country code: a local Indian
  // number can itself start with 91. Explicit international numbers must
  // match a supported country code and cannot fall back to a local format.
  if (number.length === 13 && number.startsWith("861")) {
    return countryCodeMap.CN;
  }
  if (number.length === 12 && number.startsWith("91")) {
    number = number.slice(2);
  } else if (international) {
    return "";
  }

  if (number.length === 11 && number[0] === "1") {
    return countryCodeMap.CN;
  }

  // India also permits a trunk prefix when writing a national number.
  if (!international && number.length === 11 && number[0] === "0") {
    number = number.slice(1);
  }

  if (number.length === 10 && number[0] >= "6" && number[0] <= "9") {
    return countryCodeMap.IN;
  }

  return "";
}

/**
 * Whether a host belongs to Apple. Requests to Apple carry session cookies
 * (and, on download exchange, the DSID), so this decides where they may go:
 * a cookie without a `Domain` attribute is host-only (RFC 6265).
 */
const APPLE_HOST_RE = /(^|\.)apple\.com$/i;

export function isAppleHost(hostname: string): boolean {
  return APPLE_HOST_RE.test(hostname);
}

export function generateDeviceId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function storeAPIHost(pod?: string): string {
  if (pod) return `p${pod}-buy.itunes.apple.com`;
  return "p25-buy.itunes.apple.com";
}

// The volumeStore endpoint answers failureType 5002 for apps the account already
// owns; the legacy redownload dispatch endpoint serves those (fallback for
// version flows). The two endpoints name the external version id differently.
export const RETRYABLE_FAILURE_TYPE = "5002";

/** Host serving both download fallbacks advertised by the bag. */
export const DOWNLOAD_DISPATCH_HOST = "downloaddispatch.itunes.apple.com";
/** Bag key `redownloadProduct`, used when volumeStore serves no download item. */
export const REDOWNLOAD_PRODUCT_PATH = "/r/redownload";
/** Bag key `updateProduct`, used when redownload itself cannot serve the app. */
export const UPDATE_PRODUCT_PATH = "/up/updateProduct";

export const VOLUME_STORE_VERSION_KEY = "externalVersionId";
/** redownload and updateProduct both name the version `appExtVrsId`. */
export const DOWNLOAD_DISPATCH_VERSION_KEY = "appExtVrsId";

// Failure types handled by the download flow. Mirrors ipatool's
// pkg/appstore/constants.go.
export const FAILURE_DEVICE_VERIFICATION_FAILED = "1008";
export const FAILURE_PASSWORD_TOKEN_EXPIRED = "2034";
export const FAILURE_SIGN_IN_REQUIRED = "2042";
export const FAILURE_LICENSE_NOT_FOUND = "9610";
export const FAILURE_LICENSE_ALREADY_EXISTS = "5002";

export interface StoreDownloadEndpoint {
  host: string;
  path: string;
  externalVersionIdKey: string;
}

export function volumeStoreEndpoint(
  pod: string | undefined,
  deviceId: string,
): StoreDownloadEndpoint {
  return {
    host: storeAPIHost(pod),
    path: `/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=${deviceId}`,
    externalVersionIdKey: VOLUME_STORE_VERSION_KEY,
  };
}

export function redownloadEndpoint(deviceId: string): StoreDownloadEndpoint {
  return {
    host: DOWNLOAD_DISPATCH_HOST,
    path: `${REDOWNLOAD_PRODUCT_PATH}?guid=${deviceId}`,
    externalVersionIdKey: DOWNLOAD_DISPATCH_VERSION_KEY,
  };
}

/**
 * Builds an endpoint from a bag URL. ipatool's `newDownloadEndpoint` accepts
 * only an exact host/path pair (no query, fragment or credentials) and treats
 * anything else as a hard error, so the same check applies; null on mismatch.
 */
export function downloadDispatchEndpoint(
  bagURL: string,
  expectedPath: string,
  deviceId: string,
): StoreDownloadEndpoint | null {
  let url: URL;
  try {
    url = new URL(bagURL);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.host !== DOWNLOAD_DISPATCH_HOST) return null;
  if (url.pathname !== expectedPath) return null;
  if (url.search !== "" || url.hash !== "" || url.username || url.password) {
    return null;
  }

  return {
    host: url.hostname,
    path: `${expectedPath}?guid=${deviceId}`,
    externalVersionIdKey: DOWNLOAD_DISPATCH_VERSION_KEY,
  };
}

export function purchaseAPIHost(pod?: string): string {
  if (pod) return `p${pod}-buy.itunes.apple.com`;
  return "buy.itunes.apple.com";
}

export function countryToStoreId(country: string): string | undefined {
  return countryCodeMap[country.toUpperCase()];
}

export function storeIdToCountry(storeId: string): string | undefined {
  for (const [code, id] of Object.entries(countryCodeMap)) {
    if (id === storeId) return code;
  }
  return undefined;
}
