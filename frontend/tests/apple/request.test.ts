import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLE_REQUEST_TIMEOUT_MS,
  appleRequest,
} from "../../src/apple/request";
import { AppleUnreachableError } from "../../src/apple/errors";
import { libcurl } from "../../src/apple/libcurl-init";
import i18n from "../../src/i18n";

vi.mock("../../src/apple/libcurl-init", () => ({
  libcurl: { fetch: vi.fn() },
  initLibcurl: vi.fn(async () => undefined),
}));

function answer(status: number, body: string) {
  return {
    ok: true,
    status,
    statusText: "OK",
    headers: new Headers(),
    raw_headers: [["Content-Type", "text/xml"]] as [string, string][],
    text: async () => body,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const timeoutMessage = i18n.t("errors.request.timeout", {
  seconds: Math.round(APPLE_REQUEST_TIMEOUT_MS / 1000),
});

describe("apple/request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with the body and the lower-cased headers Apple sent", async () => {
    vi.mocked(libcurl.fetch).mockResolvedValue(
      answer(200, "<plist><dict/></plist>") as never,
    );

    const response = await appleRequest({
      host: "buy.itunes.apple.com",
      path: "/x?guid=abc",
      method: "POST",
      body: "<plist/>",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("<plist><dict/></plist>");
    expect(response.headers["content-type"]).toBe("text/xml");
    expect(vi.mocked(libcurl.fetch).mock.calls[0][0]).toBe(
      "https://buy.itunes.apple.com/x?guid=abc",
    );
  });

  it("gives up when Apple never answers, and cancels the transfer", async () => {
    vi.useFakeTimers();
    vi.mocked(libcurl.fetch).mockReturnValue(new Promise(() => {}) as never);

    const pending = appleRequest({
      host: "buy.itunes.apple.com",
      path: "/auth",
      method: "POST",
    });
    const assertion = expect(pending).rejects.toThrow(AppleUnreachableError);
    const message = expect(pending).rejects.toThrow(timeoutMessage);

    await vi.advanceTimersByTimeAsync(APPLE_REQUEST_TIMEOUT_MS);
    await assertion;
    await message;

    const signal = vi.mocked(libcurl.fetch).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it("gives up when the response body never finishes", async () => {
    vi.useFakeTimers();
    vi.mocked(libcurl.fetch).mockResolvedValue({
      ...answer(200, ""),
      text: () => new Promise(() => {}) as Promise<string>,
    } as never);

    const pending = appleRequest({
      host: "buy.itunes.apple.com",
      path: "/auth",
      method: "POST",
    });
    const assertion = expect(pending).rejects.toThrow(AppleUnreachableError);

    await vi.advanceTimersByTimeAsync(APPLE_REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it("reports a failed transfer as unreachable, in words a user can act on", async () => {
    vi.mocked(libcurl.fetch).mockRejectedValue(
      new Error("Request failed with error code 35: SSL connect error"),
    );

    const error = (await appleRequest({
      host: "buy.itunes.apple.com",
      path: "/auth",
      method: "POST",
    }).catch((e) => e)) as AppleUnreachableError;

    expect(error).toBeInstanceOf(AppleUnreachableError);
    // What the relay says when it gives up ("code 35: SSL connect error") is
    // what the user used to read; it is not actionable and not translated.
    expect(error.message).toBe(i18n.t("errors.request.unreachable"));
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toContain("SSL connect error");
  });

  it("leaves no timer behind once Apple has answered", async () => {
    vi.useFakeTimers();
    vi.mocked(libcurl.fetch).mockResolvedValue(answer(200, "ok") as never);

    await appleRequest({ host: "buy.itunes.apple.com", path: "/x", method: "GET" });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a request at the twenty seconds its error message quotes", () => {
    expect(APPLE_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(timeoutMessage).toContain("20");
  });
});
