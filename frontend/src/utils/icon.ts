import type { DownloadTask } from "../types";

const APPLE_IMAGE_SIZE_RE = /\/(\d+)x(\d+)bb\.(jpg|jpeg|png|webp)(\?.*)?$/i;

export interface AppleImageSize {
  width: number;
  height: number;
}

/** The dimensions Apple encodes in an App Store image URL, when it has them. */
export function appleImageSize(url: string): AppleImageSize | undefined {
  const match = url.match(APPLE_IMAGE_SIZE_RE);
  if (!match) return undefined;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { width, height };
}

/**
 * Ask Apple's image CDN for the requested rendition. URLs without Apple's
 * `WxHbb` suffix are returned untouched.
 */
export function resizeAppleImage(
  url: string,
  width: number,
  height: number,
): string {
  if (width <= 0 || height <= 0) return url;
  return url.replace(
    APPLE_IMAGE_SIZE_RE,
    (_match, _width, _height, extension, query = "") =>
      `/${Math.round(width)}x${Math.round(height)}bb.${extension}${query}`,
  );
}

/**
 * Where a download's icon comes from. The storefront artwork wins — it is how
 * the store catalogues the app and what search results already show. A download
 * from a bare app id never saw the storefront, so it falls back to the icon the
 * backend lifted from the compiled package, or nothing at all (the caller draws
 * its own placeholder).
 */
export function taskIconUrl(task: DownloadTask): string | undefined {
  if (task.software.artworkUrl) return task.software.artworkUrl;
  if (!task.hasIcon) return undefined;

  const params = new URLSearchParams({ accountHash: task.accountHash });
  return `/api/downloads/${task.id}/icon?${params}`;
}
