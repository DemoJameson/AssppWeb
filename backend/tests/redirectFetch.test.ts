import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_REDIRECTS,
  UnsafeRedirectError,
  fetchFollowingRedirects,
  isAllowedFetchTarget,
} from "../src/utils/redirectFetch.js";

/** A response the helper can read: status, headers, and a body to release. */
function response(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(status >= 300 && status < 400 ? null : "body", {
    status,
    headers,
  });
}

const redirect = (location: string, status = 302) =>
  response(status, { location });

describe("isAllowedFetchTarget", () => {
  it("allows an HTTPS name, wherever it points", () => {
    // Apple's CDN redirects wherever it likes; a public host is not the threat.
    expect(isAllowedFetchTarget(new URL("https://cdn.example.com/x"))).toBeNull();
    expect(
      isAllowedFetchTarget(new URL("https://iosapps.itunes.apple.com/x")),
    ).toBeNull();
  });

  it("refuses a literal address, in any of the forms a redirect may use", () => {
    for (const url of [
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
    ]) {
      expect(isAllowedFetchTarget(new URL(url))).not.toBeNull();
    }
  });

  it("refuses a name that only resolves inside a network", () => {
    for (const url of [
      "https://localhost/x",
      "https://metadata.google.internal/x",
      "https://printer.local/x",
      "https://admin.home.arpa/x",
    ]) {
      expect(isAllowedFetchTarget(new URL(url))).not.toBeNull();
    }
  });

  it("refuses anything that is not HTTPS", () => {
    expect(isAllowedFetchTarget(new URL("http://example.com/x"))).not.toBeNull();
    // The path the frontend uses for the SAP assets cannot smuggle a scheme in.
    expect(isAllowedFetchTarget(new URL("file:///etc/passwd"))).not.toBeNull();
  });
});

describe("fetchFollowingRedirects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(...responses: Response[]) {
    const fetchMock = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return next;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns the answer without following anything when it is not a redirect", async () => {
    const fetchMock = stubFetch(response(200));

    const res = await fetchFollowingRedirects("https://example.com/app.ipa");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Manual by default: the hops are this module's to check, not undici's.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect to another public host and returns its answer", async () => {
    const fetchMock = stubFetch(
      redirect("https://cdn.example.com/app.ipa"),
      response(206),
    );

    const res = await fetchFollowingRedirects("https://example.com/app.ipa");

    expect(res.status).toBe(206);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.example.com/app.ipa");
  });

  it("resolves a relative Location against the request it came from", async () => {
    const fetchMock = stubFetch(redirect("/elsewhere.ipa"), response(200));

    await fetchFollowingRedirects("https://example.com/app/dir/app.ipa");

    expect(fetchMock.mock.calls[1][0]).toBe("https://example.com/elsewhere.ipa");
  });

  it("refuses a redirect aimed at an internal address, without requesting it", async () => {
    const fetchMock = stubFetch(redirect("http://169.254.169.254/latest/"));

    await expect(
      fetchFollowingRedirects("https://example.com/app.ipa"),
    ).rejects.toBeInstanceOf(UnsafeRedirectError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a host only reachable inside a network", async () => {
    const fetchMock = stubFetch(redirect("https://registry.internal/v2/"));

    await expect(
      fetchFollowingRedirects("https://example.com/app.ipa"),
    ).rejects.toThrow(/only reachable from inside a network/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands back a redirect with nowhere to go instead of chasing it", async () => {
    const fetchMock = stubFetch(response(304));

    const res = await fetchFollowingRedirects("https://example.com/app.ipa");

    expect(res.status).toBe(304);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on a redirect loop rather than following it for ever", async () => {
    const loop: Response[] = [];
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      loop.push(redirect(`https://example.com/hop${i}`));
    }
    const fetchMock = stubFetch(...loop);

    await expect(
      fetchFollowingRedirects("https://example.com/app.ipa"),
    ).rejects.toThrow(/too many redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});