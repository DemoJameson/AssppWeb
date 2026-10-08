// Fetching a URL the *client* supplied, following redirects only where allowed:
// `validateDownloadURL` pins the task URL to Apple's domains over HTTPS, but
// undici's `redirect: "follow"` would chase a redirect anywhere (SSRF). So each
// hop must be HTTPS to a host this server may reach — Apple's CDN still works,
// while a literal IP, `localhost`, or an internal-only suffix is refused.

/** How many hops a single fetch may follow before it is called a loop. */
export const MAX_REDIRECTS = 10;

/** Host suffixes that only resolve inside a network, never a public CDN. */
const INTERNAL_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
];

const INTERNAL_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/** Thrown when a hop leaves the addresses this server may fetch. */
export class UnsafeRedirectError extends Error {
  constructor(
    public readonly target: string,
    reason: string,
  ) {
    super(`refusing a redirect to ${target}: ${reason}`);
    this.name = "UnsafeRedirectError";
  }
}

/**
 * Whether a URL is one this server may fetch: HTTPS, a hostname rather than a
 * literal address, and not an internal-only name. A public host that *resolves*
 * to an internal address still passes — catching that needs a resolver.
 */
export function isAllowedFetchTarget(url: URL): string | null {
  if (url.protocol !== "https:") {
    return `the scheme is ${url.protocol.replace(":", "")}, not https`;
  }

  const host = url.hostname.toLowerCase();
  if (host === "") return "the host is empty";
  // Bracketed IPv6 arrives with its brackets; a dotted quad is an address too.
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return "the host is a literal address";
  }
  if (INTERNAL_HOSTNAMES.has(host) || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return "the host is only reachable from inside a network";
  }

  return null;
}

/** Releases a response we are not going to read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/**
 * Fetches `url`, following up to {@link MAX_REDIRECTS} hops, refusing any that
 * {@link isAllowedFetchTarget} rejects. Returns the answering response with its
 * body intact for the caller to stream.
 */
export async function fetchFollowingRedirects(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let current = url;

  for (let hop = 0; ; hop += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      // A 3xx with nowhere to go is an answer in itself; the caller reports it.
      return response;
    }

    if (hop >= MAX_REDIRECTS) {
      await discard(response);
      throw new Error(`too many redirects fetching ${url}`);
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await discard(response);
      throw new Error(`unusable redirect location from ${current}`);
    }

    const refusal = isAllowedFetchTarget(next);
    if (refusal) {
      await discard(response);
      throw new UnsafeRedirectError(next.toString(), refusal);
    }

    await discard(response);
    current = next.toString();
  }
}