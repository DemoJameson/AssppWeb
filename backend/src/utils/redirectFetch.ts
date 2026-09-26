// Fetching a URL the *client* supplied, with the redirects it is allowed to
// follow decided here rather than by the HTTP client.
//
// `validateDownloadURL` pins the URL a task is created with to Apple's domains
// over HTTPS. A redirect is the one leg of that trip nobody chose: the client
// picks the first URL, whoever answers picks the next, and undici's
// `redirect: "follow"` would chase it anywhere — an internal address included.
// `packageVersionMetadata` refuses redirects outright for the same reason, but
// it hands what it reads back to the client; a download's bytes are written to
// a package that is validated before anyone sees it, so the danger here is
// narrower and does not justify breaking Apple's own CDN hops: an internal
// address being probed, and the difference between its answers surfacing in a
// task's error message.
//
// So the hops are followed, and each one is checked to be HTTPS to a host this
// server may reach. That keeps Apple's CDN working wherever it points while
// refusing the addresses an SSRF target would use (a literal IP, `localhost`,
// or a name under a suffix that only resolves inside a network).

/** How many hops a single fetch may follow before it is called a loop. */
export const MAX_REDIRECTS = 10;

/**
 * Host suffixes that only resolve inside a network: a redirect to one of these
 * is aimed at this deployment's own surroundings, not at a CDN.
 */
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
 * Whether a URL is one this server may fetch: HTTPS, to a host that is a name
 * rather than an address, and not a name that only exists inside a network.
 *
 * A public hostname that *resolves* to an internal address still gets through —
 * catching that needs a resolver, and the URL is Apple's own reply rather than
 * the caller's. This is the check that costs nothing and closes the addresses a
 * redirect could actually be aimed at.
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
 * Fetches `url`, following up to {@link MAX_REDIRECTS} redirects and refusing
 * any hop {@link isAllowedFetchTarget} rejects. The returned response is the
 * one that answered, with its body intact for the caller to stream.
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