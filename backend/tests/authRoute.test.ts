import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import express from "express";
import request from "supertest";

// Set the instance password before the module graph (and config.ts) loads.
process.env.ACCESS_PASSWORD = "auth-route-test-password";

const authRoutes = (await import("../src/routes/auth.js")).default;
const TOKEN = createHash("sha256")
  .update("auth-route-test-password")
  .digest("hex");

const app = express();
app.use(express.json());
app.use("/api", authRoutes);

// supertest reuses one keep-alive agent by default, which Express sees as one
// socket — exactly the shared-bucket shape a reverse proxy produces.
const agent = request.agent(app);

describe("POST /api/auth/verify", () => {
  it("does not consume quota for successful verifications", async () => {
    for (let i = 0; i < 15; i++) {
      const res = await agent.post("/api/auth/verify").send({ token: TOKEN });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
  });

  it("blocks the 11th failed verification with 429", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await agent
        .post("/api/auth/verify")
        .send({ token: "wrong" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false });
    }

    const blocked = await agent.post("/api/auth/verify").send({
      token: "wrong",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: "Too many attempts, try again later",
    });
  });

  it("reports that a password is required", async () => {
    const res = await agent.get("/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ required: true });
  });
});
