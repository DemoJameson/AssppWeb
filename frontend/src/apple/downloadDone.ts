// Best-effort "songDownloadDone" report, mirroring ipatool-cpp's
// report_download_done: a GET to the bag's endpoint with the account cookies and
// DSID, so Apple can mark the purchase/download as completed. Failure is never
// allowed to affect the downloaded package.

import type { Account } from "../types";
import { fetchBag } from "./bag";
import { isStoreCommerceHost, storeUserAgent } from "./config";
import { parsePlist } from "./plist";
import { appleRequest } from "./request";

export async function reportDownloadDone(
  account: Account,
  appId: number | string,
  downloadId = "",
): Promise<boolean> {
  const bag = await fetchBag(account.deviceIdentifier);
  const endpoint = bag.songDownloadDoneEndpoint;
  if (!endpoint) return false;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !isStoreCommerceHost(url.hostname)) {
    return false;
  }

  // The bag may already be pod-personalised; otherwise inject the account pod
  // exactly as ipatool-cpp does.
  if (account.pod && !/^p[0-9]+-/.test(url.hostname)) {
    url.hostname = `p${account.pod}-${url.hostname}`;
    if (!isStoreCommerceHost(url.hostname)) return false;
  }

  url.searchParams.set("songId", String(appId));
  url.searchParams.set("download-id", downloadId);
  url.searchParams.set("Pod", account.pod ?? "");
  url.searchParams.set("guid", account.deviceIdentifier);

  const response = await appleRequest({
    method: "GET",
    host: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers: {
      "User-Agent": storeUserAgent,
      Accept: "*/*",
      "Accept-Language": "en-US",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
      "X-Apple-Store-Front": account.storeFront || `${account.store}-1`,
    },
    cookies: account.cookies,
  });

  if (response.status !== 200) return false;
  try {
    const data = parsePlist(response.body) as Record<string, any>;
    return data?.jingleDocType === "success";
  } catch {
    return false;
  }
}
