import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { JoinCodeService } from "../../src/backend/service/joinCodeService.js";

function makeService(
  overrides: Partial<Record<keyof JoinCodeService, unknown>> = {},
): JoinCodeService {
  return {
    generateCode: vi.fn(),
    resolveCode: vi
      .fn<(code: string) => Promise<string | null>>()
      .mockResolvedValue(null),
    deleteForGame: vi.fn(),
    cleanupExpired: vi.fn(),
    ...overrides,
  } as unknown as JoinCodeService;
}

async function makeApp(service: JoinCodeService) {
  const { createResolveJoinCodeRouter } =
    await import("../../src/backend/api/game/resolveJoinCode.js");
  const { errorHandler } =
    await import("../../src/backend/middleware/errorHandler.js");
  const app = express();
  app.use(express.json());
  app.use("/games/join", createResolveJoinCodeRouter(service));
  app.use(errorHandler);
  return app;
}

describe("GET /games/join/:code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with gameId when code resolves", async () => {
    const service = makeService({
      resolveCode: vi.fn().mockResolvedValue("game-abc"),
    });
    const app = await makeApp(service);

    const res = await request(app).get("/games/join/H7K3");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gameId: "game-abc" });
  });

  it("normalizes the code to uppercase before resolving", async () => {
    const resolveCode = vi.fn().mockResolvedValue("game-abc");
    const service = makeService({ resolveCode });
    const app = await makeApp(service);

    await request(app).get("/games/join/h7k3");

    expect(resolveCode).toHaveBeenCalledWith("H7K3");
  });

  it("returns 404 when code is not found", async () => {
    const service = makeService({
      resolveCode: vi.fn().mockResolvedValue(null),
    });
    const app = await makeApp(service);

    const res = await request(app).get("/games/join/XXXX");

    expect(res.status).toBe(404);
  });
});
