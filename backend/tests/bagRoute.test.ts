import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import https from "https";
import { EventEmitter } from "events";
import bplistCreator from "bplist-creator";
import plist from "plist";
import bagRoutes from "../src/routes/bag.js";

function createApp() {
  const app = express();
  app.use("/api", bagRoutes);
  return app;
}

describe("Bag Route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Configurator headers when fetching bag", async () => {
    const getSpy = vi
      .spyOn(https, "get")
      .mockImplementation((url: any, options: any, cb: any) => {
        const response = new EventEmitter() as any;
        response.statusCode = 200;
        setTimeout(() => {
          response.emit(
            "data",
            '<Document><Protocol><plist version="1.0"><dict><key>urlBag</key><dict><key>authenticateAccount</key><string>https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate</string></dict></dict></plist></Protocol></Document>',
          );
          response.emit("end");
        }, 0);
        cb(response);
        return new EventEmitter() as any;
      });

    const app = createApp();
    const res = await request(app).get("/api/bag?guid=aabbccddeeff");

    expect(res.status).toBe(200);
    expect(res.text).toContain("<plist");
    expect(getSpy).toHaveBeenCalledTimes(1);

    const [url, options] = getSpy.mock.calls[0];
    expect(String(url)).toContain("ix=6");
    expect(options.headers["User-Agent"]).toContain("Configurator/2.21");
    expect(options.headers.Accept).toBe("application/xml");
  });

  it("returns 502 when bag upstream is HTTP error", async () => {
    vi.spyOn(https, "get").mockImplementation(
      (url: any, options: any, cb: any) => {
        const response = new EventEmitter() as any;
        response.statusCode = 403;
        setTimeout(() => {
          response.emit("data", "forbidden");
          response.emit("end");
        }, 0);
        cb(response);
        return new EventEmitter() as any;
      },
    );

    const app = createApp();
    const res = await request(app).get("/api/bag?guid=aabbccddeeff");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Bag request failed");
  });

  it("unwraps a signed bag whose payload is a binary plist", async () => {
    const inner = bplistCreator({
      authenticateAccount: "https://auth.itunes.apple.com/auth/v1/native",
      "md-finish-provisioning":
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
    });
    const outer = plist.build({
      bag: inner,
      certs: Buffer.from([1, 2, 3]),
    });

    vi.spyOn(https, "get").mockImplementation(
      (url: any, options: any, cb: any) => {
        const response = new EventEmitter() as any;
        response.statusCode = 200;
        setTimeout(() => {
          response.emit("data", `<Document>${outer}</Document>`);
          response.emit("end");
        }, 0);
        cb(response);
        return new EventEmitter() as any;
      },
    );

    const app = createApp();
    const res = await request(app).get("/api/bag?guid=aabbccddeeff");

    expect(res.status).toBe(200);
    expect(res.text).toContain("<key>authenticateAccount</key>");
    expect(res.text).toContain("/auth/v1/native");
    expect(res.text).toContain("md-finish-provisioning");
    expect(res.text).not.toContain("<key>bag</key>");
  });
});
