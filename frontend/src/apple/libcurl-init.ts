import { libcurl } from "libcurl.js";
import libcurlWasmUrl from "libcurl.js/libcurl.wasm?url";
import { getAccessToken } from "../components/Auth/PasswordGate";

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function initLibcurl(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    let wsUrl = `${wsProto}//${location.host}/wisp/`;
    const token = getAccessToken();
    if (token) {
      wsUrl += `?token=${encodeURIComponent(token)}`;
    }
    libcurl.set_websocket(wsUrl);
    // The wasm engine is a separate asset: it downloads only when Apple
    // networking is first initialized, not when this module is loaded.
    await libcurl.load_wasm(libcurlWasmUrl);
    initialized = true;
  })();

  return initPromise;
}

export { libcurl };
