import { libcurl, initLibcurl } from "./libcurl-init";
import { buildCookieHeader } from "./cookies";
import { userAgent } from "./config";
import { AppleUnreachableError } from "./errors";
import i18n from "../i18n";
import type { Cookie } from "../types";

export interface AppleRequestOptions {
  host: string;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  cookies?: Cookie[];
}

export interface AppleResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: [string, string][];
  body: string;
}

/**
 * How long one Apple request may take, response body included. The WASM curl
 * client has no timeout of its own, so this bound only fires on a stalled request
 * (every measured answer arrives within seconds) — callers then get a fresh attempt.
 */
export const APPLE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * A transport failure with a user-readable message; curl's own text stays in
 * `cause` for the console. `delivered=true` marks a response that arrived but whose
 * body failed to read — Apple already acted, so repeating could duplicate it (see the type).
 */
function unreachable(error: unknown, delivered = false): AppleUnreachableError {
  return new AppleUnreachableError(
    i18n.t("errors.request.unreachable"),
    error,
    delivered,
  );
}

/**
 * Calls an Apple host through the wisp tunnel, cancelling the request once it
 * outlives {@link APPLE_REQUEST_TIMEOUT_MS} so the curl stream is freed. Every
 * failure means no answer arrived, raised as {@link AppleUnreachableError}.
 */
export async function appleRequest(
  opts: AppleRequestOptions,
): Promise<AppleResponse> {
  await initLibcurl();

  const url = `https://${opts.host}${opts.path}`;
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    ...opts.headers,
  };

  if (opts.cookies?.length) {
    const cookieHeader = buildCookieHeader(opts.cookies, url);
    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new AppleUnreachableError(
          i18n.t("errors.request.timeout", {
            seconds: Math.round(APPLE_REQUEST_TIMEOUT_MS / 1000),
          }),
        ),
      );
    }, APPLE_REQUEST_TIMEOUT_MS);
  });

  const transfer = (async (): Promise<AppleResponse> => {
    let resp;
    try {
      resp = await libcurl.fetch(url, {
        method: opts.method,
        headers,
        body: opts.body,
        redirect: "manual",
        signal: controller.signal,
        _libcurl_http_version: 1.1,
      });
    } catch (error) {
      throw unreachable(error);
    }

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of resp.raw_headers) {
      responseHeaders[key.toLowerCase()] = value;
    }

    let body: string;
    try {
      body = await resp.text();
    } catch (error) {
      // The response has started, so Apple already processed this request.
      throw unreachable(error, true);
    }

    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
      rawHeaders: resp.raw_headers,
      body,
    };
  })();

  // A transfer that loses the race must not surface later as an unhandled
  // rejection: the timeout above already answered for it.
  transfer.catch(() => undefined);

  try {
    return await Promise.race([transfer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
