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
 * How long one Apple request may take, response body included.
 *
 * The WASM curl client carries no timeout of its own: when Apple never answers,
 * its promise stays pending for as long as the peer holds the socket open, so
 * the screen that waits on it spins with nothing left to show — the sign-in
 * button sat there forever after a verification code was submitted. Every
 * answer this app has measured arrives in seconds (the SAP certificate in 0.2s,
 * the setup exchange in 0.1s, the auth endpoint in 0.3–1.5s, a storefront page
 * in 2s, the slowest handshake through the tunnel in 4s), so a bound here only
 * ever fires on a request that stalled; the callers that retry (authenticate
 * does, and the download chain moves to its next endpoint) then get a fresh
 * attempt instead of the caller waiting on a dead one.
 */
export const APPLE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * What a transport failure becomes. The message is the one the user reads (a
 * toast, the line under a button), and curl's own text — "Request failed with
 * error code 35: SSL connect error" — is not that: it names nothing the user can
 * act on, in a language they may not read. The relay closes the stream outright
 * once every address of a host has stayed silent, which is how the opaque
 * version used to reach the screen. The detail is kept in `cause`, where a
 * console shows it.
 */
function unreachable(error: unknown): AppleUnreachableError {
  return new AppleUnreachableError(
    i18n.t("errors.request.unreachable"),
    error,
  );
}

/**
 * Calls an Apple host through the wisp tunnel. The request is cancelled, not
 * merely abandoned, once it outlives {@link APPLE_REQUEST_TIMEOUT_MS}: the
 * abort tears down the curl handle so the stream is freed and the promise
 * settles with a translated error the UI can show. Every failure here means no
 * answer arrived, and is raised as {@link AppleUnreachableError} so callers can
 * tell it apart from an answer Apple sent.
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
      throw unreachable(error);
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
