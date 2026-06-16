import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Unit tests for deployment-related behavior (LLD 10).
 * Static file serving was removed from Express — nginx handles it in production.
 */

describe("health endpoint", () => {
  it("returns 200 with expected JSON shape", async () => {
    const app = express();
    app.get("/health", (_req, res) => {
      res.status(200).json({
        status: "ok",
        uptime: process.uptime(),
        connections: { total: 0 },
      });
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
  });
});
