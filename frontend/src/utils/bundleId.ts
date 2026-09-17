/**
 * Terms that read as a bundle identifier — reverse-DNS shape: dot-separated
 * segments of letters, digits and hyphens, no whitespace. Apple's fuzzy search
 * answers such a term with unrelated apps, so the search flow routes it
 * through the exact lookup instead (`searchApps` never sees it).
 */
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** The longest legal CFBundleIdentifier is 255 characters. */
const MAX_LENGTH = 255;

export function looksLikeBundleId(term: string): boolean {
  const trimmed = term.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return false;
  return BUNDLE_ID_RE.test(trimmed);
}
