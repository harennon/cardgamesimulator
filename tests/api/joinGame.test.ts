import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "../../src/backend/database/entities/Game.js";

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["player-1"];
  game.playerDisplayNames = { "player-1": "Player One" };
  game.maxPlayers = 4;
  game.status = "CREATED";
  game.state = {};
  game.version = 1;
  Object.assign(game, overrides);
  return game;
}

const mockGetGame = vi.fn<(id: string) => Promise<Game | null>>();
const mockSaveGame = vi.fn<(game: Game) => Promise<Game>>();

vi.mock("@/database", () => ({
  gameRepo: {
    getGame: (...args: unknown[]) => mockGetGame(args[0] as string),
    saveGame: (...args: unknown[]) => mockSaveGame(args[0] as Game),
  },
}));

// Must set env before importing handler (authMiddleware reads it at module load)
process.env.SUPABASE_JWT_SECRET = "test-secret";

const { JoinGameHandler } =
  await import("../../src/backend/api/game/joinGame.js");

function makeRequest(userId: string, gameId: string) {
  return {
    userId,
    body: { gameId },
    headers: {},
  } as unknown as Parameters<(typeof JoinGameHandler.INSTANCE)["post"]>[0];
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

describe("JoinGameHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveGame.mockImplementation(async (game) => game);
  });

  describe("happy path", () => {
    it("adds userId to playerIds and saves", async () => {
      const game = makeGame({ playerIds: ["player-1"] });
      mockGetGame.mockResolvedValue(game);

      const { res, data } = makeResponse();
      await JoinGameHandler.INSTANCE.post(
        makeRequest("player-2", "game-1"),
        res,
      );

      expect(data.statusCode).toBe(200);
      expect(data.body).toEqual({ gameId: "game-1", gameType: "big2" });
      expect(mockSaveGame).toHaveBeenCalledOnce();
      expect(mockSaveGame.mock.calls[0][0].playerIds).toContain("player-2");
      expect(mockSaveGame.mock.calls[0][0].playerDisplayNames["player-2"]).toBe(
        "player-2",
      );
    });
  });

  describe("duplicate join (idempotent)", () => {
    it("returns success without saving when user already in game with display name", async () => {
      const game = makeGame({
        playerIds: ["player-1", "player-2"],
        playerDisplayNames: {
          "player-1": "Player One",
          "player-2": "Player Two",
        },
      });
      mockGetGame.mockResolvedValue(game);

      const { res, data } = makeResponse();
      await JoinGameHandler.INSTANCE.post(
        makeRequest("player-2", "game-1"),
        res,
      );

      expect(data.statusCode).toBe(200);
      expect(mockSaveGame).not.toHaveBeenCalled();
    });

    it("saves display name when user is already in game but name is missing", async () => {
      const game = makeGame({
        playerIds: ["player-1", "player-2"],
        playerDisplayNames: { "player-1": "Player One" },
      });
      mockGetGame.mockResolvedValue(game);

      const { res, data } = makeResponse();
      await JoinGameHandler.INSTANCE.post(
        makeRequest("player-2", "game-1"),
        res,
      );

      expect(data.statusCode).toBe(200);
      expect(mockSaveGame).toHaveBeenCalledOnce();
      expect(mockSaveGame.mock.calls[0][0].playerDisplayNames["player-2"]).toBe(
        "player-2",
      );
    });
  });

  describe("capacity rejection", () => {
    it("throws 409 when game is full", async () => {
      const game = makeGame({
        playerIds: ["p1", "p2", "p3", "p4"],
        maxPlayers: 4,
      });
      mockGetGame.mockResolvedValue(game);

      const { res } = makeResponse();
      await expect(
        JoinGameHandler.INSTANCE.post(makeRequest("p5", "game-1"), res),
      ).rejects.toMatchObject({ status: 409 });
      expect(mockSaveGame).not.toHaveBeenCalled();
    });
  });

  describe("game not found", () => {
    it("throws 404 when game does not exist", async () => {
      mockGetGame.mockResolvedValue(null);

      const { res } = makeResponse();
      await expect(
        JoinGameHandler.INSTANCE.post(makeRequest("p1", "no-game"), res),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("optimistic lock retry", () => {
    it("retries once on version conflict and succeeds", async () => {
      const game = makeGame({ playerIds: ["player-1"] });
      mockGetGame.mockResolvedValue(game);

      const versionError = new Error("version mismatch");
      versionError.name = "OptimisticLockVersionMismatchError";

      mockSaveGame
        .mockRejectedValueOnce(versionError)
        .mockResolvedValueOnce(game);

      const { res, data } = makeResponse();
      await JoinGameHandler.INSTANCE.post(
        makeRequest("player-2", "game-1"),
        res,
      );

      expect(data.statusCode).toBe(200);
      expect(mockGetGame).toHaveBeenCalledTimes(2);
      expect(mockSaveGame).toHaveBeenCalledTimes(2);
    });

    it("throws 409 when retry also fails with version conflict", async () => {
      const game = makeGame({ playerIds: ["player-1"] });
      mockGetGame.mockResolvedValue(game);

      const versionError = new Error("version mismatch");
      versionError.name = "OptimisticLockVersionMismatchError";

      mockSaveGame.mockRejectedValue(versionError);

      const { res } = makeResponse();
      await expect(
        JoinGameHandler.INSTANCE.post(makeRequest("player-2", "game-1"), res),
      ).rejects.toMatchObject({ status: 409 });
      expect(mockSaveGame).toHaveBeenCalledTimes(2);
    });
  });

  describe("display name deduplication", () => {
    it("keeps requested name when no conflict exists", async () => {
      const game = makeGame({ playerIds: ["player-1"] });
      mockGetGame.mockResolvedValue(game);

      const { res } = makeResponse();
      const req = makeRequest("player-2", "game-1");
      req.displayName = "Alice";
      await JoinGameHandler.INSTANCE.post(req, res);

      expect(mockSaveGame.mock.calls[0][0].playerDisplayNames["player-2"]).toBe(
        "Alice",
      );
    });

    it("appends ' 2' when name already exists in game", async () => {
      const game = makeGame({
        playerIds: ["player-1"],
        playerDisplayNames: { "player-1": "Alice" },
      });
      mockGetGame.mockResolvedValue(game);

      const { res } = makeResponse();
      const req = makeRequest("player-2", "game-1");
      req.displayName = "Alice";
      await JoinGameHandler.INSTANCE.post(req, res);

      expect(mockSaveGame.mock.calls[0][0].playerDisplayNames["player-2"]).toBe(
        "Alice 2",
      );
    });

    it("increments suffix until unique when multiple conflicts exist", async () => {
      const game = makeGame({
        playerIds: ["player-1"],
        playerDisplayNames: { "player-1": "Alice", "player-x": "Alice 2" },
      });
      mockGetGame.mockResolvedValue(game);

      const { res } = makeResponse();
      const req = makeRequest("player-2", "game-1");
      req.displayName = "Alice";
      await JoinGameHandler.INSTANCE.post(req, res);

      expect(mockSaveGame.mock.calls[0][0].playerDisplayNames["player-2"]).toBe(
        "Alice 3",
      );
    });
  });

  describe("validation", () => {
    it("throws 400 when userId is missing", async () => {
      const { res } = makeResponse();
      const req = makeRequest(undefined as unknown as string, "game-1");
      req.userId = undefined;
      await expect(
        JoinGameHandler.INSTANCE.post(req, res),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("throws 400 when gameId is missing", async () => {
      const { res } = makeResponse();
      await expect(
        JoinGameHandler.INSTANCE.post(makeRequest("p1", ""), res),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
