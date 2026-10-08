import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import {
  authenticate,
  AuthenticationError,
} from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { AppleUnreachableError } from "../../src/apple/errors";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

// The real bag module, so `defaultAuthURL` — the endpoint a sign-in falls back
// to — stays the shipping one instead of a copy that can drift from it.
vi.mock("../../src/apple/bag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/apple/bag")>()),
  fetchBag: vi.fn(),
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });

  it.each([
    ["13800138000", "143465"],
    ["test@example.com", undefined],
  ])("signs in %s against %s", async (appleId, expected) => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: { appleId, address: {} },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      appleId,
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    expect(requestCall.headers?.["X-Apple-Store-Front"]).toBe(expected);
  });

  it.each([
    ["asked for a code", undefined, true],
    ["refused the code", "123456", false],
  ])(
    "names the BadLogin answer it %s",
    async (_name, code, expectedCodeRequired) => {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          failureType: "",
          customerMessage: "MZFinance.BadLogin.Configurator_message",
        }),
      });

      const err = await authenticate(
        "13800138000",
        "password",
        code,
        undefined,
        "aabbccddeeff",
      ).catch((e) => e);

      expect(err).toBeInstanceOf(AuthenticationError);
      expect((err as AuthenticationError).codeRequired).toBe(
        expectedCodeRequired,
      );
      expect((err as Error).message).not.toContain("MZFinance.BadLogin");
    },
  );

  it("signs in on the retry when the first request is never answered", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    // What a request that outlived the client's own timeout throws.
    vi.mocked(appleRequest)
      .mockRejectedValueOnce(new AppleUnreachableError("request timed out"))
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          accountInfo: { appleId: "test@example.com", address: {} },
          passwordToken: "token",
          dsPersonId: "123",
        }),
      });

    const account = await authenticate(
      "test@example.com",
      "password",
      "123456",
      undefined,
      "aabbccddeeff",
    );

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(account.passwordToken).toBe("token");
    expect(account.directoryServicesIdentifier).toBe("123");
  });

  it("asks Apple's other endpoint when the storefront one never answers", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1",
    });
    vi.mocked(appleRequest)
      .mockRejectedValueOnce(new AppleUnreachableError("tunnel stalled"))
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          accountInfo: { appleId: "test@example.com", address: {} },
          passwordToken: "token",
          dsPersonId: "123",
        }),
      });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    expect(appleRequest).toHaveBeenCalledTimes(2);
    const first = vi.mocked(appleRequest).mock.calls[0][0];
    const second = vi.mocked(appleRequest).mock.calls[1][0];
    expect(first.host).toBe("buy.itunes.apple.com");
    expect(second.host).toBe("auth.itunes.apple.com");
    expect(second.path).toContain("/auth/v1/native/fast/");
    // The guid still rides along, and the body is the same sign-in either way.
    expect(second.path).toContain("guid=aabbccddeeff");
    expect(second.body).toBe(first.body);
  });

  it("keeps a refused sign-in on the endpoint that answered it", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    // Apple answered — with a refusal. That is not a reason to try elsewhere:
    // the sign-in itself was seen, and refusing it is Apple's decision.
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({ failureType: "1000", customerMessage: "nope" }),
    });

    const error = await authenticate(
      "test@example.com",
      "wrong",
      undefined,
      undefined,
      "aabbccddeeff",
    ).catch((e) => e);

    expect((error as Error).message).toBe("nope");
    const hosts = vi
      .mocked(appleRequest)
      .mock.calls.map((call) => call[0].host);
    expect(hosts).not.toContain("auth.itunes.apple.com");
    expect(new Set(hosts)).toEqual(new Set(["buy.itunes.apple.com"]));
  });

  it("replays the signed sign-in at the pod a redirect names", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 302,
        statusText: "Found",
        headers: {
          location:
            "https://p30-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=aabbccddeeff",
        },
        rawHeaders: [],
        body: "",
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          accountInfo: { appleId: "test@example.com", address: {} },
          passwordToken: "token",
          dsPersonId: "123",
        }),
      });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    expect(appleRequest).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(appleRequest).mock.calls;
    expect(second[0].host).toBe("p30-buy.itunes.apple.com");
    // Apple answers a sign-in only on the slashed path — the bare one returns HTML — so the
    // hop keeps the slash even though the Location omitted it.
    expect(second[0].path).toBe(
      "/WebObjects/MZFinance.woa/wa/authenticate/?guid=aabbccddeeff",
    );
    // The pod hand-off belongs to the same attempt, so the signed body travels
    // unchanged and the signature still covers what Apple receives.
    expect(second[0].body).toBe(first[0].body);
  });

  it("does not re-post the sign-in for a 303", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    // 303 asks for a GET, which is not a request the sign-in can be replayed
    // as, so it must not be mistaken for a pod hand-off.
    vi.mocked(appleRequest).mockResolvedValue({
      status: 303,
      statusText: "See Other",
      headers: { location: "https://p30-buy.itunes.apple.com/elsewhere" },
      rawHeaders: [],
      body: "",
    });

    await expect(
      authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      ),
    ).rejects.toBeInstanceOf(Error);

    // It may be retried as a fresh attempt, but never as a re-post to the 303's
    // Location — that would be the GET Apple actually asked for.
    for (const [call] of vi.mocked(appleRequest).mock.calls) {
      expect(call.host).toBe("buy.itunes.apple.com");
    }
  });
});
