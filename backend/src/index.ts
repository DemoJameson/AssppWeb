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

// Whether the socket address or the client a proxy reports is the caller's.
// Off by default; see `TRUST_PROXY` in config.ts, and `rateLimitKey` for what
// reads it.
app.set("trust proxy", config.trustProxy);

// Middleware
app.use(httpsRedirect);
app.use(securityHeaders);

// Body parsing happens after accessAuth, so an unauthenticated request is
// rejected before its body is read at all. The download-creation route needs
// the large limit (base64 SINFs + iTunesMetadata); it is mounted before the
// global parser because body-parser skips requests it has already parsed
// (req._body set), letting every other route stay at 1mb.
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
//
// Cache headers here are load-bearing, not an optimisation. Every route is
// code-split, so switching tabs is what fetches /assets/*.js — a burst of
// small requests straight at the origin. Served without an explicit
// Cache-Control (which is what express.static does by default) the browser
// treats them as revalidate-always, so each one becomes a conditional request
// that still occupies an origin connection. Enough of those and the edge in
// front starts answering 521, which fails the module fetch and — before the
// error boundary existed — left the user on a blank page.
//
// So: /assets/* is content-hashed by the bundler, meaning a URL that exists
// can never change meaning. Those are immutable and safe to keep for a year.
// Everything else in public/ (icons, manifest) keeps a short lifetime.
//
// index.html is the exception and is handled below, because express.static
// serves it here first and never falls through to the SPA route.
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
// that simply does not exist.
//
// Only the paths the bundler emits live under these directories (plus the
// handful of files at the public root). Restricting the no-fallback rule to
// them is what keeps a real route working: `/accounts/someone@example.com`
// ends in `.com`, and judging by file extension alone would 404 a page the
// app actually serves. Anything under /assets/ counts, at any depth, because
// that directory holds nothing but emitted files.
const EMITTED_FILE_RE =
  /^\/assets\/|^(\/manifest\.json|\/favicon(?:-[\w-]+)?\.\w+|\/icon-[\w-]+\.png|\/apple-touch-icon\.png)$/;

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }

  // A request for a file the bundler emits is asking for that file, not for a
  // route. Answering it with index.html would be a lie the browser cannot
  // detect, and the lie travels: the response is a 200 carrying HTML, so a CDN
  // in front of this server is entitled to cache it and hand it to the next
  // browser as if it were the JavaScript that was asked for. With
  // `X-Content-Type-Options: nosniff` that browser then refuses to evaluate
  // it, and the dynamic import fails with no way for the page to recover —
  // which is exactly how a stale chunk name (one from a previous deploy, now
  // deleted) took the whole app down on a tab switch.
  //
  // So a missing asset must 404 honestly, answered here rather than passed
  // along: the only handler left downstream turns everything into a 500, and a
  // 500 carrying JSON is not a better answer than a 404. `no-store` as well,
  // because a CDN must not hold on to a miss — the whole failure began with
  // one being cached.
  if (EMITTED_FILE_RE.test(req.path)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).type("txt").send("Not found");
    return;
  }

  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) {
    // `no-cache` still allows storing the document, but forces revalidation on
    // every load. That is required rather than merely nice: index.html is the
    // only thing naming the current content-hashed chunks, so a cached copy
    // from a previous deploy asks the browser for assets/*.js files the server
    // no longer has. Those requests fail, and "Failed to fetch dynamically
    // imported module" is the visible symptom of exactly that.
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
  // A PUBLIC_BASE_URL that set nothing usable is worth saying out loud: from
  // the outside it is indistinguishable from having configured it and having
  // the install links quietly come out of the request Host instead.
  const baseUrlWarning = publicBaseUrlWarning(process.env.PUBLIC_BASE_URL);
  if (baseUrlWarning) console.warn(baseUrlWarning);
});

export { app, server };
