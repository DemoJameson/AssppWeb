import { apiGet } from './client';

export interface InstallInfo {
  installUrl: string;
  manifestUrl: string;
}

/**
 * Asks the backend for this package's install links.
 *
 * They cannot be built here: iOS opens the manifest, the payload and the icons
 * itself, without the access token, so each URL carries a short-lived signature
 * the *server* holds the key for (see `middleware/accessAuth`). The endpoint
 * that mints them is behind the token, which this call carries.
 */
export async function getInstallInfo(id: string): Promise<InstallInfo> {
  return apiGet<InstallInfo>(`/api/install/${encodeURIComponent(id)}/url`);
}

/**
 * Hands the install URL to the OS. A seam of its own because jsdom cannot
 * navigate to custom schemes — the component tests stub it out.
 */
export function openInstallUrl(url: string): void {
  window.location.assign(url);
}
