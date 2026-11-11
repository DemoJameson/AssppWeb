import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../src/services/anisette.js", () => {
  class AnisetteUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AnisetteUnavailableError";
    }
  }

  return {
    AnisetteUnavailableError,
    anisetteStatus: vi.fn(),
    prepareAnisette: vi.fn(),
    requestAuthHeaders: vi.fn(),
    requestAuthAction: vi.fn(),
    requestStoreProof: vi.fn(),
  };
});

import anisetteRoutes from "../src/routes/anisette.js";
import {
  AnisetteUnavailableError,
  anisetteStatus,
  prepareAnisette,
  requestAuthAction,
  requestAuthHeaders,
  requestStoreProof,
} from "../src/services/anisette.js";

function createApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", anisetteRoutes);
  return app;
}

describe("Anisette routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports whether the helper is available", async () => {
    vi.mocked(anisetteStatus).mockReturnValue({
      available: true,
      running: false,
      helperPath: "/opt/asspp/anisette",
    });

    const res = await request(createApp()).get("/api/anisette/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      running: false,
      helperPath: "/opt/asspp/anisette",
    });
  });

  it("prepares the helper and reports readiness", async () => {
    vi.mocked(prepareAnisette).mockResolvedValue();

    const res = await request(createApp()).post("/api/anisette/prepare");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ready: true });
  });

  it("returns 503 when the helper is unavailable", async () => {
    vi.mocked(prepareAnisette).mockRejectedValue(
      new AnisetteUnavailableError("no helper"),
    );

    const res = await request(createApp()).post("/api/anisette/prepare");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no helper");
  });

  it("proxies auth headers without accepting extra credential fields", async () => {
    vi.mocked(requestAuthHeaders).mockResolvedValue({
      state: "state-2",
      headers: { "X-Apple-AMD": "otp" },
    });

    const res = await request(createApp())
      .post("/api/anisette/auth/headers")
      .send({
        deviceIdentifier: "aabbccddeeff",
        state: "state-1",
        authEndpoint:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
        password: "should-not-pass",
      });

    expect(res.status).toBe(200);
    expect(res.body.headers["X-Apple-AMD"]).toBe("otp");
    expect(requestAuthHeaders).toHaveBeenCalledWith(
      "aabbccddeeff",
      "state-1",
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      undefined,
    );
  });

  it("requires the fields an SP action needs", async () => {
    const res = await request(createApp())
      .post("/api/anisette/auth/action")
      .send({ deviceIdentifier: "aabbccddeeff" });

    expect(res.status).toBe(400);
    expect(requestAuthAction).not.toHaveBeenCalled();
  });

  it("proxies an SP action", async () => {
    vi.mocked(requestAuthAction).mockResolvedValue({
      state: "state-3",
      headers: { "X-Apple-AMD": "otp" },
    });

    const forbidden = {
      ["Cookie"]: "hidden",
      ["X" + "-Token"]: "hidden",
    };
    const res = await request(createApp())
      .post("/api/anisette/auth/action")
      .send({
        deviceIdentifier: "aabbccddeeff",
        state: "state-2",
        action: "SP",
        data: "challenge",
        authEndpoint:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
        identityHeaders: {
          "X-Mme-Device-Id": "device",
          ...forbidden,
        },
      });

    expect(res.status).toBe(200);
    expect(requestAuthAction).toHaveBeenCalledWith(
      "aabbccddeeff",
      "state-2",
      "SP",
      "challenge",
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      { "X-Mme-Device-Id": "device" },
      { family: undefined, finishUrl: undefined },
    );
  });

  it("forwards the MD family and bag-provided finish URL", async () => {
    vi.mocked(requestAuthAction).mockResolvedValue({
      state: "state-3",
      headers: { "X-Apple-MD": "otp" },
    });

    const res = await request(createApp())
      .post("/api/anisette/auth/action")
      .send({
        deviceIdentifier: "aabbccddeeff",
        state: "state-2",
        action: "SP",
        data: "challenge",
        authEndpoint:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
        family: "md",
        finishUrl:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
      });

    expect(res.status).toBe(200);
    expect(requestAuthAction).toHaveBeenCalledWith(
      "aabbccddeeff",
      "state-2",
      "SP",
      "challenge",
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      {},
      {
        family: "md",
        finishUrl:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
      },
    );
  });

  it("proxies a Store proof request", async () => {
    vi.mocked(requestStoreProof).mockResolvedValue({
      state: "state-2",
      headers: { "X-Apple-AMD": "otp" },
    });

    const res = await request(createApp())
      .post("/api/anisette/store/proof")
      .send({
        deviceIdentifier: "aabbccddeeff",
        state: "state-1",
        endpoint:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff",
      });

    expect(res.status).toBe(200);
    expect(requestStoreProof).toHaveBeenCalledWith(
      "aabbccddeeff",
      "state-1",
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff",
      undefined,
    );
  });

  it("returns 502 when the helper answered with an Apple failure", async () => {
    vi.mocked(requestStoreProof).mockRejectedValue(new Error("bad proof"));

    const res = await request(createApp())
      .post("/api/anisette/store/proof")
      .send({
        deviceIdentifier: "aabbccddeeff",
        state: "state-1",
        endpoint:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff",
      });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("bad proof");
  });

  it("rate limits a client before it can exhaust the helper", async () => {
    const app = createApp();
    app.set("trust proxy", true);
    vi.mocked(requestAuthHeaders).mockResolvedValue({
      state: "state",
      headers: {},
    });

    for (let index = 0; index < 30; index++) {
      const res = await request(app)
        .post("/api/anisette/auth/headers")
        .set("X-Forwarded-For", "203.0.113.9")
        .send({ deviceIdentifier: "aabbccddeeff" });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app)
      .post("/api/anisette/auth/headers")
      .set("X-Forwarded-For", "203.0.113.9")
      .send({ deviceIdentifier: "aabbccddeeff" });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("Too many");
  });
});
