import { apiGet } from './client';

export interface InstallInfo {
  installUrl: string;
  manifestUrl: string;
}

/**
 * Asks the backend for this package's install links: they carry a short-lived
 * signature the *server* holds the key for (iOS fetches the manifest, payload and
 * icons without the access token; see `middleware/accessAuth`). The minting
 * endpoint is behind the token this call carries.
 */
export async function getInstallInfo(id: string): Promise<InstallInfo> {
  return apiGet<InstallInfo>(`/api/install/${encodeURIComponent(id)}/url`);
}

/**
 * Hands the install URL to the OS. A test seam: jsdom cannot navigate to
 * custom schemes.
 */
export function openInstallUrl(url: string): void {
  window.location.assign(url);
}

/**
 * Hands a download URL to the browser — the same navigation as an install link,
 * and a test seam for the same reason. Kept apart from `openInstallUrl` so a test
 * asserting a download cannot be satisfied by an install.
 */
export function openDownloadUrl(url: string): void {
  window.location.assign(url);
}
