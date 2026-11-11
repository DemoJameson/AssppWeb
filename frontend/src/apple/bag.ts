import { authHeaders } from "../api/client";
import { parsePlist } from "./plist";
import type { SapEndpoints } from "./sap/types";

export interface BagOutput {
  authURL: string;
  /** Present when the bag advertises the SAP signing protocol. */
  sapEndpoints?: SapEndpoints;
  /**
   * Download fallback hosts; the flow consults these instead of hardcoding the
   * dispatch host (ipatool reads `urlBag.redownloadProduct` / `updateProduct`).
   */
  redownloadEndpoint?: string;
  updateEndpoint?: string;
  /** Bag key `volumeStoreDownloadProduct`; Apple now points this at ent/download. */
  entDownloadEndpoint?: string;
  /** Apple's AMD provisioning finish endpoint (`otp/1.5/finish` today). */
  amdFinishProvisioning?: string;
  /** Apple's MD provisioning finish endpoint (the legacy MZFinance path). */
  mdFinishProvisioning?: string;
  /** Bag key `songDownloadDone`; the post-download completion report. */
  songDownloadDoneEndpoint?: string;
  /** Machine-sync endpoints, retained for diagnostics/future SM handling. */
  amdSyncMachine?: string;
  mdSyncMachine?: string;
}

export const defaultAuthURL =
  "https://auth.itunes.apple.com/auth/v1/native/fast/";

/**
 * The storefront/Configurator sign-in endpoint. The bag can advertise the
 * native endpoint instead (the `ix=6` generation does); if native keeps
 * answering 204/404 without an SP action, authenticate retries this endpoint
 * once so Apple can answer RP/SP and let the helper provision Store AMD.
 */
export const legacyAuthURL =
  "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/";

const NATIVE_AUTH_HOST = "auth.itunes.apple.com";

// The bag advertises the native auth endpoint as-is; ipatool sends that exact
// path and leaves the guid in the request body. Do not rewrite the native URL.
// The legacy storefront endpoint wants a trailing slash. Other URLs pass
// through.
const LEGACY_AUTH_PATH = "/wa/authenticate";

/**
 * The backend returns the signed bag unwrapped. Look at the flat root and the
 * legacy `urlBag` nesting; no other shape reaches this client.
 */
function findBagString(
  dict: Record<string, any>,
  key: string,
): string | undefined {
  const direct = dict[key];
  if (typeof direct === "string" && direct !== "") return direct;

  const urlBag = dict.urlBag;
  if (urlBag && typeof urlBag === "object") {
    return findBagString(urlBag as Record<string, any>, key);
  }

  return undefined;
}

export function normalizeAuthURL(rawURL: string): string {
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    return rawURL;
  }
  if (url.hostname === NATIVE_AUTH_HOST) {
    return rawURL;
  }
  if (url.pathname.endsWith(LEGACY_AUTH_PATH)) {
    url.pathname = `${url.pathname}/`;
    return url.toString();
  }
  return rawURL;
}

// Fetches the bag via the backend proxy (Node.js native HTTPS). The response is
// public data (Apple service URLs, no credentials).
export async function fetchBag(deviceId: string): Promise<BagOutput> {
  try {
    const resp = await fetch(`/api/bag?guid=${encodeURIComponent(deviceId)}`, {
      headers: authHeaders(),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.warn(
        `[Bag] Proxy request failed, using default auth endpoint: ${err.error || `HTTP ${resp.status}`}`,
      );
      return { authURL: defaultAuthURL };
    }

    const xml = await resp.text();
    const dict = parsePlist(xml) as Record<string, any>;

    // authenticateAccount moved from the urlBag dict to the plist root in newer
    // responses, so prefer the root and fall back.
    const authURL = findBagString(dict, "authenticateAccount");

    const bagValue = (key: string): string | undefined =>
      findBagString(dict, key);

    const setupURL = bagValue("sign-sap-setup");
    const certificateURL = bagValue("sign-sap-setup-cert");
    const versionText = bagValue("sign-sap-version");
    let sapEndpoints: SapEndpoints | undefined;
    if (setupURL && certificateURL && versionText) {
      const version = Number.parseInt(versionText, 10);
      if (Number.isFinite(version)) {
        sapEndpoints = { setupURL, certificateURL, version };
      }
    }

    const downloadEndpoints = {
      entDownloadEndpoint: bagValue("volumeStoreDownloadProduct"),
      redownloadEndpoint: bagValue("redownloadProduct"),
      updateEndpoint: bagValue("updateProduct"),
      amdFinishProvisioning: bagValue("amd-finish-provisioning"),
      mdFinishProvisioning: bagValue("md-finish-provisioning"),
      songDownloadDoneEndpoint: bagValue("songDownloadDone"),
      amdSyncMachine: bagValue("amd-sync-machine"),
      mdSyncMachine: bagValue("md-sync-machine"),
    };

    if (!authURL) {
      console.warn(
        "[Bag] authenticateAccount URL not found in bag, using default auth endpoint",
      );
      return { authURL: defaultAuthURL, sapEndpoints, ...downloadEndpoints };
    }

    return {
      authURL: normalizeAuthURL(authURL),
      sapEndpoints,
      ...downloadEndpoints,
    };
  } catch (error) {
    console.warn(
      `[Bag] Failed to fetch/parse bag, using default auth endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { authURL: defaultAuthURL };
  }
}
