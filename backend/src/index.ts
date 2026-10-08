import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { config, publicBaseUrlWarning } from "./config.js";
import { httpsRedirect } from "./middleware/httpsRedirect.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { accessAuth } from "./middleware/accessAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { setupWsProxy } from "./services/wsProxy.js";
import authRoutes from "./routes/auth.js";
import searchRoutes from "./routes/search.js";
import downloadRoutes from "./routes/downloads.js";
import packageRoutes from "./routes/packages.js";
import installRoutes from "./routes/install.js";
import settingsRoutes from "./routes/settings.js";
import bagRoutes from "./routes/bag.js";
import sapAssetRoutes from "./routes/sapAssets.js";
import versionMetadataRoutes from "./routes/versionMetadata.js";
import versionPinRoutes from "./routes/versionPins.js";
import packageBuildRoutes from "./routes/packageBuilds.js";

const app = express();

// Whether the socket address or the client a proxy reports is the caller's. Off
// by default; see `TRUST_PROXY` in config.ts, and `rateLimitKey` for what reads it.
app.set("trust proxy", config.trustProxy);

// Middleware
app.use(httpsRedirect);
app.use(securityHeaders);

// Body parsing happens after accessAuth, so an unauthenticated request is
// rejected before its body is read. The download-creation route needs the large
// limit (base64 SINFs + iTunesMetadata) and is mounted before the global parser,
// because body-parser skips already-parsed requests (req._body set), letting the
// rest stay at 1mb.
app.use("/api", accessAuth);
app.use("/api/downloads", express.json({ limit: "50mb" }));
app.use(express.json({ limit: "1mb" }));

// API routes
app.use("/api", authRoutes);
app.use("/api", searchRoutes);
app.use("/api", downloadRoutes);
app.use("/api", packageRoutes);
app.use("/api", installRoutes);
app.use("/api", settingsRoutes);
app.use("/api", bagRoutes);
app.use("/api", sapAssetRoutes);
app.use("/api", versionMetadataRoutes);
app.use("/api", versionPinRoutes);
app.use("/api", packageBuildRoutes);

// Serve static frontend files.
const publicDir = path.resolve(import.meta.dirname, "../public");
// Cache headers here are load-bearing, not an optimisation: every route is code-split, so
// switching tabs fetches /assets/*.js, and without an explicit Cache-Control each such request
// revalidates while occupying an origin connection — enough of them and the edge answers 521,
// failing the module fetch and blanking the page. /assets/* is content-hashed: immutable, safe
// for a year. Everything else in public/ gets a short lifetime; index.html is handled below.
app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (name === "index.html") {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  }),
);

// SPA fallback: serve index.html for real navigation, never for a static asset
// that simply does not exist. Only the paths the bundler emits live under these
// directories (plus a few files at the public root); limiting the no-fallback
// rule to them is what keeps a real route working, since
// `/accounts/someone@example.com` ends in `.com` but is a page the app serves.
// Anything under /assets/ counts, at any depth — it holds only emitted files.
const EMITTED_FILE_RE =
  /^\/assets\/|^(\/manifest\.json|\/favicon(?:-[\w-]+)?\.\w+|\/icon-[\w-]+\.png|\/apple-touch-icon\.png)$/;

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }

  // A request for a file the bundler emits is asking for that file, not a route: answering
  // index.html is a 200 HTML a CDN may cache and hand to the next browser as if it were the JS it
  // asked for, which `nosniff` then makes fail irrecoverably — exactly how a stale chunk name once
  // took the app down on a tab switch. So a missing asset must 404 honestly, answered here (the only
  // handler left downstream turns everything into a 500), with `no-store` so a CDN does not hold the miss.
  if (EMITTED_FILE_RE.test(req.path)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).type("txt").send("Not found");
    return;
  }

  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) {
    // `no-cache` still allows storing the document, but forces revalidation on
    // every load. Required: index.html is the only thing naming the current
    // content-hashed chunks, so a cached copy from a previous deploy asks the
    // browser for assets/*.js the server no longer has — which fails as
    // "Failed to fetch dynamically imported module".
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexPath);
  } else {
    next();
  }
});

// Error handler (must be last)
app.use(errorHandler);

// Create HTTP server
const server = createServer(app);

// WebSocket proxy for Apple TCP connections
setupWsProxy(server);

// Ensure data directory exists
fs.mkdirSync(config.dataDir, { recursive: true });

server.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
  console.log(`Data directory: ${path.resolve(config.dataDir)}`);
  // A PUBLIC_BASE_URL that set nothing usable is worth warning about: from the
  // outside it looks identical to a working config, install links falling back to
  // the request Host instead.
  const baseUrlWarning = publicBaseUrlWarning(process.env.PUBLIC_BASE_URL);
  if (baseUrlWarning) console.warn(baseUrlWarning);
});

export { app, server };
