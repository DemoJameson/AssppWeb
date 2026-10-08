import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * The SPA fallback used to answer every non-API GET with index.html and a 200,
 * including `/assets/<file>.js` for files that do not exist. That is what let a
 * CDN hand HTML to a browser asking for JavaScript: a real outage, where a tab
 * switch fetched a chunk name from a previous deploy and got the app shell
 * instead, cached and served as if it were the module the browser asked for.
 *
 * These tests drive real HTTP against the actual app from index.ts — not a copy
 * of its logic. The failure was entirely about what goes over the wire (status,
 * content-type, cache-control), and a mocked `res`, or a re-implemented
 * fallback, would only prove that this file calls the methods it calls.
 */

// Importing the app also starts it, so pin an ephemeral port first.
process.env.PORT = "0";
const { app, server } = await import("../src/index.js");

let base: string;

beforeAll(async () => {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A chunk name from a build that no longer exists on disk. */
const STALE_CHUNK = "assets/PageContainer-deadbeef.js";

describe("static assets", () => {
  it("serves a chunk that exists as JavaScript, cached immutably", async () => {
    // The real chunk name is whatever this build emitted, so read it from the
    // document rather than hard-coding a hash that changes every build.
    const home = await fetch(`${base}/`);
    const html = await home.text();
    const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    expect(entry, "index.html should reference an entry chunk").toBeDefined();

    const res = await fetch(`${base}/${entry}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    // Content-hashed, so it can never change meaning.
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("404s a chunk that does not exist, and never answers with HTML", async () => {
    // The regression that caused the outage: this used to be 200 + index.html.
    const res = await fetch(`${base}/${STALE_CHUNK}`);
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/html");
    expect(body).not.toContain("<!doctype");
    expect(body).not.toContain("<html");
  });

  it("marks a miss uncacheable, so no CDN holds on to it", async () => {
    // The failure began with a bad response being cached. A 404 that says
    // "you may store this" is the same trap one status code down.
    const res = await fetch(`${base}/${STALE_CHUNK}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s a missing asset repeatedly, staying stable", async () => {
    // A CDN that revalidates must keep getting the same honest answer rather
    // than drifting between a miss and a stale document.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/${STALE_CHUNK}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("<!doctype");
    }
  });

  it("404s other missing emitted files too, not just chunks", async () => {
    // Names that no build emits, so a miss is a miss rather than a real file
    // being served.
    for (const p of [
      "/assets/nope.js",
      "/assets/nope.css",
      "/assets/deadbeef.js",
      "/assets/nested/deep.js",
      "/icon-999x999.png",
    ]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).not.toContain("<!doctype");
    }
  });

  it("still serves the real root-level files it does have", async () => {
    // The rule names emitted files to protect them from the fallback; it must
    // not turn files that exist into 404s.
    for (const p of ["/manifest.json", "/favicon.ico"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(200);
    }
  });
});

describe("SPA fallback", () => {
  it("serves index.html for an extensionless route", async () => {
    for (const route of ["/", "/downloads", "/search", "/accounts/add"]) {
      const res = await fetch(`${base}${route}`);
      const body = await res.text();

      expect(res.status, `route ${route}`).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(body, `route ${route}`).toContain("<!doctype");
    }
  });

  it("still serves a route whose last segment looks like a filename", async () => {
    // `/accounts/:email` matches an address, and every address ends in a TLD.
    // Deciding "is this a file?" by extension alone would 404 a real page —
    // which is why the no-fallback rule names the emitted files instead.
    for (const route of [
      "/accounts/someone@example.com",
      "/accounts/a@b.co.uk",
      "/search/1234567890",
    ]) {
      const res = await fetch(`${base}${route}`);
      expect(res.status, `route ${route}`).toBe(200);
      expect(await res.text(), `route ${route}`).toContain("<!doctype");
    }
  });

  it("keeps index.html revalidated on every load", async () => {
    // A cached index.html names chunks from the deploy that produced it, which
    // is what makes a stale chunk request in the first place.
    const res = await fetch(`${base}/downloads`);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("still lets /api 404 rather than handing it the app shell", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<!doctype");
  });
});