import { getAccessToken } from "../components/Auth/PasswordGate";

const BASE_URL = "";

export function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { "X-Access-Token": token } : {};
}

/**
 * Builds the Error thrown for a non-2xx response: surfaces the backend's
 * `{"error": "..."}` field as the message, falling back to the body text or the
 * status code.
 */
async function toError(res: Response): Promise<Error> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { error?: unknown };
    if (typeof data.error === "string" && data.error) {
      return new Error(data.error);
    }
  } catch {
    // Not JSON — use the raw text below.
  }
  return new Error(text || `HTTP ${res.status}`);
}

export async function apiGet<T>(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: authHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function apiPost<T>(
  path: string,
  body?: any,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = options?.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  const onAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  if (options?.signal?.aborted) controller.abort();

  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    };
    if (options?.timeoutMs || options?.signal) {
      init.signal = controller.signal;
    }

    const res = await fetch(`${BASE_URL}${path}`, init);
    if (!res.ok) throw await toError(res);
    return res.json();
  } finally {
    if (timer) clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

export async function apiPut<T>(
  path: string,
  body?: any,
  options?: { keepalive?: boolean },
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    keepalive: options?.keepalive,
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw await toError(res);
}
