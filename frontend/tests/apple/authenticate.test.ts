import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist, parsePlist } from "../../src/apple/plist";
import {
  authenticate,
  AuthenticationError,
  directoryServicesIdentifierFromResponse,
  sanitizeAuthCodeInput,
} from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { AppleUnreachableError } from "../../src/apple/errors";
import {
  fetchAuthHeaders,
  handleAuthAction,
} from "../../src/apple/anisette";
import { getAnisetteState } from "../../src/apple/anisetteStore";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

// The real bag module, so `defaultAuthURL` — the endpoint a sign-in falls back
// to — stays the shipping one instead of a copy that can drift from it.
vi.mock("../../src/apple/bag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/apple/bag")>()),
  fetchBag: vi.fn(),
}));

vi.mock("../../src/apple/anisette", () => ({
  fetchAuthHeaders: vi.fn().mockResolvedValue({
    state: "test-anisette-state",
    headers: {},
  }),
  handleAuthAction: vi.fn(),
  runAnisetteTask: vi.fn(
    async (_device: string, task: () => Promise<unknown>) => task(),
  ),
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchAuthHeaders).mockResolvedValue({
      state: "test-anisette-state",
      headers: {},
    });
    vi.mocked(handleAuthAction).mockReset();
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

    expect(endpoint.searchParams.get("guid")).toBe("AABBCCDDEEFF");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });

  it("normalizes whitespace in a 2FA code without changing the password", async () => {
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
        accountInfo: { appleId: "test@example.com", address: {} },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "päss word",
      " 123 456 ",
      undefined,
      "aabbccddeeff",
    );

    const body = parsePlist(
      vi.mocked(appleRequest).mock.calls[0][0].body ?? "",
    ) as Record<string, unknown>;
    expect(body.attempt).toBe("2");
    expect(body.password).toBe("päss word123456");
  });

  it.each(["12345", "1234567", "12345a", "１２３４５６", "   "])(
    "rejects malformed 2FA code %s before contacting Apple",
    async (code) => {
      await expect(
        authenticate(
          "test@example.com",
          "password",
          code,
          undefined,
          "aabbccddeeff",
        ),
      ).rejects.toMatchObject({ name: "AuthenticationError" });

      expect(fetchBag).not.toHaveBeenCalled();
      expect(appleRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    [" 123 456 ", "123456"],
    ["12a3456", "123456"],
    ["１２３４５６", ""],
    ["1234567", "123456"],
  ])("sanitizes pasted 2FA input %s", (value, expected) => {
    expect(sanitizeAuthCodeInput(value)).toBe(expected);
  });

  it("treats an empty code as no code", async () => {
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
        accountInfo: { appleId: "test@example.com", address: {} },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      "",
      undefined,
      "aabbccddeeff",
    );

    const body = parsePlist(
      vi.mocked(appleRequest).mock.calls[0][0].body ?? "",
    ) as Record<string, unknown>;
    expect(body.attempt).toBe("1");
    expect(body.password).toBe("password");
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

  it("retries invalid credentials with attempt 2", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          failureType: "-5000",
          customerMessage: "invalid credentials",
        }),
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
      "aabbccddee10",
    );

    const attempts = vi
      .mocked(appleRequest)
      .mock.calls.map(
        ([request]) =>
          (parsePlist(request.body ?? "") as Record<string, unknown>).attempt,
      );
    expect(attempts).toEqual(["1", "2"]);
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
    // The native endpoint carries the guid in the body, not the query.
    expect(second.path).not.toContain("guid=");
    expect(second.body).toContain("AABBCCDDEEFF");
    expect(second.body).toBe(first.body);

    const proofCalls = vi.mocked(fetchAuthHeaders).mock.calls;
    expect(proofCalls).toHaveLength(2);
    expect(proofCalls[1][2]).toContain("auth.itunes.apple.com");
    expect(proofCalls[1][2]).not.toContain("guid=");
  });

  it("uses the native auth endpoint the bag advertises", async () => {
    const deviceId = "aabbccddee09";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.itunes.apple.com/auth/v1/native",
    });
    vi.mocked(appleRequest).mockResolvedValue({
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

    await authenticate("test@example.com", "password", undefined, undefined, deviceId);

    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(request.host).toBe("auth.itunes.apple.com");
    expect(request.path).toContain("/auth/v1/native");
    expect(request.path).not.toContain("guid=");
    expect(request.body).toContain("AABBCCDDEE09");
    expect(fetchAuthHeaders).toHaveBeenCalledWith(
      deviceId,
      undefined,
      expect.stringContaining("auth.itunes.apple.com"),
    );
  });

  it("falls back to the legacy storefront endpoint when native never answers", async () => {
    const deviceId = "aabbccddee0a";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.itunes.apple.com/auth/v1/native",
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

    await authenticate("test@example.com", "password", undefined, undefined, deviceId);

    expect(appleRequest).toHaveBeenCalledTimes(2);
    const first = vi.mocked(appleRequest).mock.calls[0][0];
    const second = vi.mocked(appleRequest).mock.calls[1][0];
    expect(first.host).toBe("auth.itunes.apple.com");
    expect(second.host).toBe("buy.itunes.apple.com");
    expect(second.path).toContain("/WebObjects/MZFinance.woa/wa/authenticate/");
    expect(second.path).toContain("guid=AABBCCDDEE0A");
  });

  it("tries the legacy storefront after native keeps answering 204", async () => {
    const deviceId = "aabbccddee0b";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.itunes.apple.com/auth/v1/native",
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: {},
        rawHeaders: [],
        body: "",
      })
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: {},
        rawHeaders: [],
        body: "",
      })
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: {},
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

    await authenticate("test@example.com", "password", undefined, undefined, deviceId);

    expect(appleRequest).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(appleRequest).mock.calls;
    expect(calls.slice(0, 3).every(([call]) => call.host === "auth.itunes.apple.com")).toBe(true);
    expect(calls[3][0].host).toBe("buy.itunes.apple.com");
    expect(calls[3][0].path).toContain("/WebObjects/MZFinance.woa/wa/authenticate/");
    expect(calls[3][0].path).toContain("guid=AABBCCDDEE0B");
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
    expect(appleRequest).toHaveBeenCalledTimes(1);
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

    const proofCalls = vi.mocked(fetchAuthHeaders).mock.calls;
    expect(proofCalls).toHaveLength(2);
    expect(proofCalls[1][2]).toContain("p30-buy.itunes.apple.com");
    expect(proofCalls[1][2]).toContain("guid=aabbccddeeff");
  });

  it("resolves a relative redirect against the host that answered", async () => {
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
            "/WebObjects/MZFinance.woa/wa/authenticate?guid=aabbccddeeff",
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

    const second = vi.mocked(appleRequest).mock.calls[1][0];
    expect(second.host).toBe("buy.itunes.apple.com");
    expect(second.path).toBe(
      "/WebObjects/MZFinance.woa/wa/authenticate/?guid=aabbccddeeff",
    );
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

  it("sends AMD headers and the current Store user agent", async () => {
    const deviceId = "aabbccddee01";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(fetchAuthHeaders).mockResolvedValueOnce({
      state: "state-amd",
      headers: {
        "X-Apple-AMD": "otp",
        "X-Apple-AMD-M": "machine",
        "X-Apple-I-Md-Rinfo": "1",
      },
    });
    vi.mocked(appleRequest).mockResolvedValue({
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

    await authenticate("test@example.com", "password", undefined, undefined, deviceId);

    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(request.headers?.["X-Apple-AMD"]).toBe("otp");
    expect(request.headers?.["X-Apple-AMD-M"]).toBe("machine");
    expect(request.headers?.["User-Agent"]).toContain("Configurator/2.21");
    expect(fetchAuthHeaders).toHaveBeenCalledWith(
      deviceId,
      undefined,
      expect.stringContaining("guid=AABBCCDDEE01"),
    );
    expect(await getAnisetteState(deviceId)).toBe("state-amd");
  });

  it("drops machine headers when Apple answers RP", async () => {
    const deviceId = "aabbccddee02";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(fetchAuthHeaders).mockResolvedValueOnce({
      state: "state-rp",
      headers: {
        "X-Apple-AMD": "otp",
        "X-Apple-AMD-M": "machine",
        "X-Apple-I-MD-RINFO": "1",
        "X-Mme-Device-Id": "device",
      },
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: { "x-apple-amd-action": "RP" },
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

    await authenticate("test@example.com", "password", undefined, undefined, deviceId);

    const retry = vi.mocked(appleRequest).mock.calls[1][0];
    expect(retry.headers?.["X-Apple-AMD"]).toBeUndefined();
    expect(retry.headers?.["X-Apple-AMD-M"]).toBeUndefined();
    expect(retry.headers?.["X-Apple-I-MD-RINFO"]).toBeUndefined();
    expect(retry.headers?.["X-Mme-Device-Id"]).toBe("device");
  });

  it("runs Store provisioning when Apple answers SP", async () => {
    const deviceId = "aabbccddee03";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(fetchAuthHeaders).mockResolvedValueOnce({
      state: "state-sp",
      headers: {
        "X-Apple-AMD": "otp",
        "X-Apple-AMD-M": "machine",
        "X-Mme-Device-Id": "device",
      },
    });
    vi.mocked(handleAuthAction).mockResolvedValueOnce({
      state: "state-after-sp",
      headers: {
        "X-Apple-AMD": "otp2",
        "X-Apple-AMD-M": "machine2",
      },
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: {
          "x-apple-amd-action": "SP",
          "x-apple-amd-data": "challenge",
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

    await authenticate("test@example.com", "password", undefined, undefined, deviceId);

    expect(handleAuthAction).toHaveBeenCalledWith(
      deviceId,
      "state-sp",
      "SP",
      "challenge",
      expect.stringContaining("/WebObjects/MZFinance.woa/wa/authenticate"),
      expect.objectContaining({ "X-Mme-Device-Id": "device" }),
      expect.objectContaining({ family: "amd" }),
    );
    const retry = vi.mocked(appleRequest).mock.calls[1][0];
    expect(retry.headers?.["X-Apple-AMD"]).toBe("otp2");
    expect(retry.headers?.["X-Apple-AMD-M"]).toBe("machine2");
    expect(retry.headers?.["X-Mme-Device-Id"]).toBe("device");
    expect(await getAnisetteState(deviceId)).toBe("state-after-sp");
  });

  it("accepts the MD action family and sends its finish URL", async () => {
    const deviceId = "aabbccddee0d";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      mdFinishProvisioning:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
    });
    vi.mocked(fetchAuthHeaders).mockResolvedValueOnce({
      state: "state-md",
      headers: {
        "X-Apple-MD": "otp",
        "X-Apple-MD-M": "machine",
        "X-Mme-Device-Id": "device",
      },
    });
    vi.mocked(handleAuthAction).mockResolvedValueOnce({
      state: "state-after-md-sp",
      headers: {
        "X-Apple-MD": "otp2",
        "X-Apple-MD-M": "machine2",
      },
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: {
          "x-apple-md-action": "SP",
          "x-apple-md-data": "md-challenge",
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
      deviceId,
    );

    expect(handleAuthAction).toHaveBeenCalledWith(
      deviceId,
      "state-md",
      "SP",
      "md-challenge",
      expect.stringContaining("/WebObjects/MZFinance.woa/wa/authenticate"),
      expect.objectContaining({ "X-Mme-Device-Id": "device" }),
      {
        family: "md",
        finishUrl:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
      },
    );
    const retry = vi.mocked(appleRequest).mock.calls[1][0];
    expect(retry.headers?.["X-Apple-MD"]).toBe("otp2");
    expect(retry.headers?.["X-Apple-MD-M"]).toBe("machine2");
  });

  it("drops MD machine headers when Apple answers RP", async () => {
    const deviceId = "aabbccddee0e";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(fetchAuthHeaders).mockResolvedValueOnce({
      state: "state-md-rp",
      headers: {
        "X-Apple-MD": "otp",
        "X-Apple-MD-M": "machine",
        "X-Mme-Device-Id": "device",
      },
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: { "x-apple-md-action": "RP" },
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
      deviceId,
    );

    const retry = vi.mocked(appleRequest).mock.calls[1][0];
    expect(retry.headers?.["X-Apple-MD"]).toBeUndefined();
    expect(retry.headers?.["X-Apple-MD-M"]).toBeUndefined();
    expect(retry.headers?.["X-Mme-Device-Id"]).toBe("device");
  });

  it("uses X-Apple-Request-Store-Front when the set header is absent", async () => {
    const deviceId = "aabbccddee04";
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "x-apple-request-store-front": "143465-1,29" },
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
      undefined,
      undefined,
      deviceId,
    );

    expect(account.store).toBe("143465");
    expect(account.storeFront).toBe("143465-1,29");
  });

  it("reads a DSID from X-Dsid and from the mz_at cookie", () => {
    expect(
      directoryServicesIdentifierFromResponse(
        {},
        { headers: { "x-dsid": "456" }, rawHeaders: [] },
      ),
    ).toBe("456");
    expect(
      directoryServicesIdentifierFromResponse(
        {},
        {
          headers: {},
          rawHeaders: [
            ["Set-Cookie", ["mz", "_at", "_ssl-789=abc; Path=/"].join("")],
          ],
        },
      ),
    ).toBe("789");
  });

  it("explains that device verification is unavailable on a bare 204", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(fetchAuthHeaders).mockRejectedValueOnce(
      new Error("no Anisette helper"),
    );
    vi.mocked(appleRequest).mockResolvedValue({
      status: 204,
      statusText: "No Content",
      headers: {},
      rawHeaders: [],
      body: "",
    });

    await expect(
      authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddee05",
      ),
    ).rejects.toThrow(/device verification/i);
  });

  it("retries a transient empty 204 on the same endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: {},
        rawHeaders: [["Set-Cookie", "retryCookie=retry-session; Path=/"]],
        body: "",
      })
      .mockResolvedValueOnce({
        status: 204,
        statusText: "No Content",
        headers: {},
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

    const account = await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddee06",
    );

    expect(account.passwordToken).toBe("token");
    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(appleRequest).mock.calls[1][0].cookies?.some(
        (cookie) =>
          cookie.name === "retryCookie" && cookie.value === "retry-session",
      ),
    ).toBe(true);
    for (const [call] of vi.mocked(appleRequest).mock.calls) {
      expect(call.host).toBe("buy.itunes.apple.com");
    }
  });

  it("does not move an HTTP refusal to the other endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 403,
      statusText: "Forbidden",
      headers: {},
      rawHeaders: [],
      body: "",
    });

    await expect(
      authenticate(
        "test@example.com",
        "wrong",
        undefined,
        undefined,
        "aabbccddee07",
      ),
    ).rejects.toThrow(/did not answer usably/i);

    const hosts = vi
      .mocked(appleRequest)
      .mock.calls.map(([request]) => request.host);
    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(new Set(hosts)).toEqual(new Set(["buy.itunes.apple.com"]));
  });

  it("stops instead of retrying a rate limit whose wait is too long", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "120" },
      rawHeaders: [],
      body: "",
    });

    await expect(
      authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddee0f",
      ),
    ).rejects.toThrow(/HTTP 429/);

    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it("does not sleep after the last rate-limited attempt", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback: TimerHandler, delay?: number, ...args: any[]) => {
        delays.push(Number(delay ?? 0));
        return originalSetTimeout(callback, 0, ...args);
      }) as typeof globalThis.setTimeout);
    try {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.mocked(appleRequest).mockResolvedValue({
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "0" },
        rawHeaders: [],
        body: "",
      });

      await expect(
        authenticate(
          "test@example.com",
          "password",
          undefined,
          undefined,
          "aabbccddee11",
        ),
      ).rejects.toThrow(/HTTP 429/);
      expect(appleRequest).toHaveBeenCalledTimes(3);
      // Ignore the Anisette store's 10s guard; only the two retryable
      // waits should be here, and the final 429 must not add a third.
      expect(delays.filter((delay) => delay < 10_000)).toEqual([1000, 1000]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("returns a populated 403 refusal instead of retrying it", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 403,
      statusText: "Forbidden",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        failureType: "",
        customerMessage: "MZFinance.BadLogin.Configurator_message",
      }),
    });

    await expect(
      authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddee08",
      ),
    ).rejects.toThrow(/verification/i);

    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it("surfaces an authentication server dialog before a redirect", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 302,
      statusText: "Found",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        customerMessage: "MZFinance.AccountDisabled",
        dialog: {
          message: "This Apple Account has been locked for security reasons.",
          explanation: "Reset your password to continue.",
          okButtonString: "Reset",
          okButtonAction: {
            kind: "OpenURL",
            url: "https://iforgot.apple.com/cgi-bin/iforgot.cgi",
          },
        },
      }),
    });

    const error = await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddee0c",
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "This Apple Account has been locked for security reasons.",
    );
    expect((error as Error).message).toContain(
      "Reset your password to continue.",
    );
    expect((error as Error).message).toContain(
      "Reset: https://iforgot.apple.com/cgi-bin/iforgot.cgi",
    );
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it("does not expose an untrusted dialog URL", async () => {
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
        dialog: {
          message: "Account action required",
          okButtonString: "Continue",
          okButtonAction: {
            kind: "OpenURL",
            url: "https://example.com/reset",
          },
        },
      }),
    });

    const error = await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddee0d",
    ).catch((caught) => caught);

    expect((error as Error).message).toContain("Account action required");
    expect((error as Error).message).not.toContain("example.com");
    expect((error as Error).message).not.toContain("Continue:");
  });
});
