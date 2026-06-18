import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { Game } from "../../src/backend/database/entities/Game.js";
import type { GameRepository } from "../../src/backend/database/database.js";

function makeRepo(
  overrides: Partial<Record<keyof GameRepository, unknown>> = {},
): GameRepository {
  return {
    createGame: vi.fn(),
    getGame: vi.fn(),
    getGameByJoinCode: vi
      .fn<(code: string) => Promise<Game | null>>()
      .mockResolvedValue(null),
    saveGame: vi.fn(),
    ...overrides,
  } as unknown as GameRepository;
}

function makeGame(joinCode: string): Game {
  const game = new Game();
  game.gameId = "game-abc";
  game.joinCode = joinCode;
  return game;
}

async function makeApp(repo: GameRepository) {
  const { createResolveJoinCodeRouter } =
    await import("../../src/backend/api/game/resolveJoinCode.js");
  const { errorHandler } =
    await import("../../src/backend/middleware/errorHandler.js");
  const app = express();
  app.use(express.json());
  app.use("/games/join", createResolveJoinCodeRouter(repo));
  app.use(errorHandler);
  return app;
}

describe("GET /games/join/:code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with gameId when code resolves", async () => {
    const repo = makeRepo({
      getGameByJoinCode: vi.fn().mockResolvedValue(makeGame("H7K3")),
    });
    const app = await makeApp(repo);

    const res = await request(app).get("/games/join/H7K3");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gameId: "game-abc" });
  });

  it("normalizes the code to uppercase before resolving", async () => {
    const getGameByJoinCode = vi.fn().mockResolvedValue(makeGame("H7K3"));
    const repo = makeRepo({ getGameByJoinCode });
    const app = await makeApp(repo);

    await request(app).get("/games/join/h7k3");

    expect(getGameByJoinCode).toHaveBeenCalledWith("H7K3");
  });

  it("returns 404 when code is not found", async () => {
    const repo = makeRepo({
      getGameByJoinCode: vi.fn().mockResolvedValue(null),
    });
    const app = await makeApp(repo);

    const res = await request(app).get("/games/join/XXXX");

    expect(res.status).toBe(404);
  });
});
