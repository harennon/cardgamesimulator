import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "../../src/backend/database/entities/Game.js";

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["user-1"];
  game.playerDisplayNames = { "user-1": "Alice" };
  game.maxPlayers = 4;
  game.status = "CREATED";
  game.state = {};
  game.version = 1;
  Object.assign(game, overrides);
  return game;
}

const mockCreateGame =
  vi.fn<
    (
      gameId: string,
      gameType: string,
      creatorId: string,
      maxPlayers: number,
      creatorDisplayName: string,
      turnTimerSeconds: number | null,
    ) => Promise<Game>
  >();

vi.mock("@/database", () => ({
  gameRepo: {
    createGame: (
      ...args: [string, string, string, number, string, number | null]
    ) => mockCreateGame(...args),
  },
}));

process.env.SUPABASE_JWT_SECRET = "test-secret";

const { CreateGameHandler } =
  await import("../../src/backend/api/game/createGame.js");

function makeRequest(
  userId: string,
  gameType: string,
  maxPlayers: number,
  displayName?: string,
  turnTimerSeconds?: number,
) {
  return {
    userId,
    displayName,
    body: { gameType, maxPlayers, turnTimerSeconds },
    headers: {},
  } as unknown as Parameters<(typeof CreateGameHandler.INSTANCE)["post"]>[0];
}

function makeResponse() {
  const data: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    json(body: unknown) {
      data.body = body;
      return res;
    },
  };
  return { res, data };
}

describe("CreateGameHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("happy path", () => {
    it("creates game and returns gameId and gameType", async () => {
      const game = makeGame();
      mockCreateGame.mockResolvedValue(game);

      const { res, data } = makeResponse();
      await CreateGameHandler.INSTANCE.post(
        makeRequest("user-1", "big2", 4, "Alice", 30),
        res,
      );

      expect(data.statusCode).toBe(200);
      expect(data.body).toEqual({ gameId: "game-1", gameType: "big2" });
    });

    it("passes displayName to gameRepo.createGame", async () => {
      const game = makeGame();
      mockCreateGame.mockResolvedValue(game);

      const { res } = makeResponse();
      await CreateGameHandler.INSTANCE.post(
        makeRequest("user-1", "big2", 4, "Alice", 60),
        res,
      );

      expect(mockCreateGame).toHaveBeenCalledOnce();
      const [, , creatorId, , creatorDisplayName] =
        mockCreateGame.mock.calls[0];
      expect(creatorId).toBe("user-1");
      expect(creatorDisplayName).toBe("Alice");
    });

    it("falls back to userId when displayName is absent", async () => {
      const game = makeGame({ playerDisplayNames: { "user-1": "user-1" } });
      mockCreateGame.mockResolvedValue(game);

      const { res } = makeResponse();
      await CreateGameHandler.INSTANCE.post(
        makeRequest("user-1", "big2", 4, undefined, 90),
        res,
      );

      expect(mockCreateGame).toHaveBeenCalledOnce();
      const [, , , , creatorDisplayName] = mockCreateGame.mock.calls[0];
      expect(creatorDisplayName).toBe("user-1");
    });
  });

  describe("validation", () => {
    it("throws 400 when userId is missing", async () => {
      const { res } = makeResponse();
      const req = makeRequest(
        undefined as unknown as string,
        "big2",
        4,
        "Alice",
        30,
      );
      req.userId = undefined;
      await expect(
        CreateGameHandler.INSTANCE.post(req, res),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws 400 when gameType is missing", async () => {
      const { res } = makeResponse();
      await expect(
        CreateGameHandler.INSTANCE.post(
          makeRequest("user-1", "", 4, undefined, 30),
          res,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws 400 when maxPlayers is missing", async () => {
      const { res } = makeResponse();
      await expect(
        CreateGameHandler.INSTANCE.post(
          makeRequest("user-1", "big2", 0, undefined, 30),
          res,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws 400 when turnTimerSeconds is null", async () => {
      const { res } = makeResponse();
      const req = makeRequest("user-1", "big2", 4, "Alice");
      // explicitly set null
      (req.body as Record<string, unknown>).turnTimerSeconds = null;
      await expect(
        CreateGameHandler.INSTANCE.post(req, res),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws 400 when turnTimerSeconds is omitted", async () => {
      const { res } = makeResponse();
      await expect(
        CreateGameHandler.INSTANCE.post(
          makeRequest("user-1", "big2", 4, "Alice"),
          res,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws 400 when turnTimerSeconds is an invalid value (e.g. 45)", async () => {
      const { res } = makeResponse();
      await expect(
        CreateGameHandler.INSTANCE.post(
          makeRequest("user-1", "big2", 4, "Alice", 45),
          res,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
