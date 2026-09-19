/**
 * The numeric App Store id a store link carries, or undefined when the value
 * is not an Apple store URL. The path is matched for `/id…` regardless of the
 * locale segments before it (a percent-encoded Chinese app name included), so
 * any share link resolves to the same id the store uses.
 */
const STORE_HOST_RE = /(^|\.)apple\.com$/i;
const STORE_ID_RE = /\/id(\d+)/;

export function appIdFromStoreUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  // Accept scheme-less pastes too ("apps.apple.com/…/id123").
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (!STORE_HOST_RE.test(url.hostname)) return undefined;

  return url.pathname.match(STORE_ID_RE)?.[1];
}
