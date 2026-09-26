import { Server as HttpServer } from "http";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { accessPasswordHash, verifyAccessToken } from "../config.js";
import { DestinationSocket } from "./destinationSocket.js";

// Allow only Apple hosts required by bag/auth/purchase/version/download flows,
// plus the SAP signing endpoints the bag advertises (sign-sap-setup and
// sign-sap-setup-cert) and the catalogue lookup used to pin a version id before
// the redownload fallback. Leaving the SAP hosts out kills the setup exchange
// inside the TLS handshake, which the browser surfaces as
// "Request failed with error code 35: SSL connect error", while the proxy log
// shows "refusing to create a stream to s.mzstatic.com:443".
wisp.options.hostname_whitelist = [
  /^auth\.itunes\.apple\.com$/,
  /^buy\.itunes\.apple\.com$/,
  /^init\.itunes\.apple\.com$/,
  /^p\d+-buy\.itunes\.apple\.com$/,
  /^downloaddispatch\.itunes\.apple\.com$/,
  /^fpinit\.itunes\.apple\.com$/,
  /^s\.mzstatic\.com$/,
  /^uclient-api\.itunes\.apple\.com$/,
  // Storefront product pages used by the visionOS and macOS version lookups
  // (apps.apple.com/{cc}/app/id{id}?platform=vision|mac). Public content — no
  // credentials — but the browser cannot fetch them directly (CORS), so they
  // ride the wisp tunnel like every other Apple request.
  /^apps\.apple\.com$/,
];
wisp.options.port_whitelist = [443];
wisp.options.allow_direct_ip = false;
// allow_private_ips must be true: Docker/container DNS may resolve whitelisted
// hostnames to reserved-range IPs (e.g. 198.18.x.x in OrbStack). The hostname
// whitelist above is the primary security control.
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = false;

export function setupWsProxy(server: HttpServer) {
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/wisp")) {
      if (accessPasswordHash) {
        const url = new URL(req.url, "http://localhost");
        // Cloudflare URL normalization may append a trailing slash to the query
        // string (e.g. ?token=abc/ instead of ?token=abc), so strip it.
        const token = (url.searchParams.get("token") || "").replace(/\/+$/, "");
        if (!verifyAccessToken(token)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      // DestinationSocket dials the hostname's address pool in turn and swaps
      // the connection out when one stays silent — some of Apple's addresses
      // accept a connection and then never answer the handshake, which used to
      // leave the request waiting forever. See destinationSocket.ts.
      wisp.routeRequest(req, socket, head, { TCPSocket: DestinationSocket });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });
}
