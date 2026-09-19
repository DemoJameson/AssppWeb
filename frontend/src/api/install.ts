export interface InstallInfo {
  installUrl: string;
  manifestUrl: string;
}

export function getInstallInfo(id: string): InstallInfo {
  const baseUrl = window.location.origin;
  const manifestUrl = `${baseUrl}/api/install/${id}/manifest.plist`;
  const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
  return { installUrl, manifestUrl };
}

/**
 * Hands the install URL to the OS. A seam of its own because jsdom cannot
 * navigate to custom schemes — the component tests stub it out.
 */
export function openInstallUrl(url: string): void {
  window.location.assign(url);
}
