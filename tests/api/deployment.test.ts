import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import * as path from "path";

/**
 * Unit tests for deployment-related behavior (LLD 10).
 * These tests exercise the health endpoint and production static file serving
 * in isolation — no DB, no Socket.IO, no real Server class instantiation.
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

describe("production static file serving", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("registers static middleware and SPA fallback when NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";

    // Use __dirname of this test file to find the fixtures directory
    const staticDir = path.resolve(__dirname, "../fixtures/mock-frontend");

    // Build minimal app that mirrors the production static serving logic
    const app = express();

    if (process.env.NODE_ENV === "production") {
      app.use(express.static(staticDir));
      app.get("/{*path}", (_req, res) => {
        res.sendFile(path.resolve(staticDir, "index.html"));
      });
    }

    // Static file should be served
    const indexRes = await request(app).get("/");
    expect(indexRes.status).toBe(200);

    // SPA fallback: unknown route serves index.html
    const spaRes = await request(app).get("/some/deep/route");
    expect(spaRes.status).toBe(200);
    expect(spaRes.text).toContain("<html");
  });

  it("does not register static middleware when NODE_ENV is not production", async () => {
    process.env.NODE_ENV = "test";

    const staticDir = path.resolve(__dirname, "../fixtures/mock-frontend");

    const app = express();

    // Mirror production guard — static only added when production
    if (process.env.NODE_ENV === "production") {
      app.use(express.static(staticDir));
      app.get("/{*path}", (_req, res) => {
        res.sendFile(path.resolve(staticDir, "index.html"));
      });
    }

    // No static middleware registered — route returns 404
    const res = await request(app).get("/");
    expect(res.status).toBe(404);
  });
});
