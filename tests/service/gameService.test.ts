import { describe, it, expect, vi, beforeEach } from "vitest";
import { GameService } from "../../src/backend/service/gameService.js";
import { GameCache } from "../../src/backend/engine/game-cache.js";
import type { GameEngineFactory } from "../../src/backend/engine/game-engine-factory.js";
import type { GameRepository } from "../../src/backend/database/database.js";
import type { GameEngine } from "../../src/backend/engine/game-engine.js";
import type { StatsService } from "../../src/backend/service/statsService.js";
import type {
  InternalGameState,
  PlayerView,
  SpectatorView,
} from "../../src/shared/engine-types.js";
import { Game } from "../../src/backend/database/entities/Game.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  gameId: string,
  overrides: Partial<InternalGameState> = {},
): InternalGameState {
  return {
    gameId,
    gameType: "big2",
    status: "IN_PROGRESS",
    version: 1,
    players: [
      { playerId: "player-a", displayName: "Alice" },
      { playerId: "player-b", displayName: "Bob" },
    ],
    currentPlayerIndex: 0,
    turnNumber: 1,
    gameSpecificState: null,
    winner: null,
    scores: null,
    randomSeed: "seed-1",
    ...overrides,
  };
}

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["player-a", "player-b"];
  game.maxPlayers = 4;
  game.status = "CREATED";
  game.state = {};
  game.version = 1;
  Object.assign(game, overrides);
  return game;
}

function makePlayerView(gameId: string, playerId: string): PlayerView {
  return {
    gameId,
    gameType: "big2",
    status: "IN_PROGRESS",
    version: 1,
    players: [
      { playerId, displayName: "Alice", cardCount: 13, isConnected: true },
      {
        playerId: "player-b",
        displayName: "Bob",
        cardCount: 13,
        isConnected: true,
      },
    ],
    you: { playerId, displayName: "Alice", hand: [] },
    currentPlayerIndex: 0,
    turnNumber: 1,
    validActions: [],
    gameSpecificPublicState: null,
    winner: null,
    scores: null,
  };
}

function makeSpectatorView(gameId: string): SpectatorView {
  return {
    gameId,
    gameType: "big2",
    status: "IN_PROGRESS",
    version: 1,
    players: [
      {
        playerId: "player-a",
        displayName: "Alice",
        cardCount: 13,
        isConnected: true,
      },
    ],
    currentPlayerIndex: 0,
    turnNumber: 1,
    gameSpecificPublicState: null,
    winner: null,
    scores: null,
    spectatorCount: 1,
  };
}

function makeEngine(overrides: Partial<GameEngine> = {}): GameEngine {
  return {
    gameType: "big2",
    initialize: vi
      .fn()
      .mockReturnValue(makeState("game-1", { status: "IN_PROGRESS" })),
    validateAction: vi.fn().mockReturnValue(true),
    applyAction: vi.fn().mockReturnValue({
      success: true,
      newState: makeState("game-1", { version: 2 }),
    }),
    getPlayerView: vi
      .fn()
      .mockReturnValue(makePlayerView("game-1", "player-a")),
    getValidActions: vi.fn().mockReturnValue([]),
    isGameOver: vi.fn().mockReturnValue(false),
    getAutoTimeoutAction: vi.fn().mockReturnValue(null),
    getSpectatorView: vi.fn().mockReturnValue(makeSpectatorView("game-1")),
    ...overrides,
  } as unknown as GameEngine;
}

function makeEngineFactory(engine: GameEngine): GameEngineFactory {
  return {
    getEngine: vi.fn().mockReturnValue(engine),
    register: vi.fn(),
    hasEngine: vi.fn().mockReturnValue(true),
    getRegisteredTypes: vi.fn().mockReturnValue(["big2"]),
  } as unknown as GameEngineFactory;
}

function makeGameRepo(overrides: Partial<GameRepository> = {}): GameRepository {
  return {
    createGame: vi.fn(),
    getGame: vi.fn().mockResolvedValue(null),
    saveGame: vi.fn().mockImplementation(async (g: Game) => g),
    ...overrides,
  };
}

function makeStatsService(): StatsService {
  return {
    recordGameCompletion: vi.fn().mockResolvedValue(undefined),
  } as unknown as StatsService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GameService", () => {
  describe("getGameState", () => {
    it("returns cached state without hitting the DB when cache has the game", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      cache.set("game-1", state);

      const repo = makeGameRepo();
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getGameState("game-1");

      expect(result).toBe(state);
      expect(repo.getGame).not.toHaveBeenCalled();
    });

    it("loads from DB and caches when cache misses", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      const game = makeGame({
        status: "IN_PROGRESS",
        state: state as unknown as Record<string, unknown>,
      });

      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getGameState("game-1");

      expect(result).toMatchObject({ gameId: "game-1" });
      expect(repo.getGame).toHaveBeenCalledWith("game-1");
      // Subsequent call should hit cache
      await service.getGameState("game-1");
      expect(repo.getGame).toHaveBeenCalledTimes(1);
    });

    it("returns null when the game does not exist in DB", async () => {
      const cache = new GameCache();
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(null) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getGameState("nonexistent");

      expect(result).toBeNull();
    });

    it("returns null when the game exists but has no state (not started)", async () => {
      const cache = new GameCache();
      const game = makeGame({ status: "CREATED", state: {} });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getGameState("game-1");

      expect(result).toBeNull();
    });
  });

  describe("getJoinCode", () => {
    it("returns the game's joinCode from the DB on first read", async () => {
      const cache = new GameCache();
      const game = makeGame({ joinCode: "H7K3" });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getJoinCode("game-1");

      expect(result).toBe("H7K3");
    });

    it("returns null when the game has no joinCode", async () => {
      const cache = new GameCache();
      const game = makeGame({ joinCode: null });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getJoinCode("game-1");

      expect(result).toBeNull();
    });

    it("returns null when the game does not exist", async () => {
      const cache = new GameCache();
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(null) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getJoinCode("game-1");

      expect(result).toBeNull();
    });

    it("memoizes the immutable join code — only one DB read across repeated calls", async () => {
      const cache = new GameCache();
      const game = makeGame({ joinCode: "H7K3" });
      const getGame = vi.fn().mockResolvedValue(game);
      const repo = makeGameRepo({ getGame });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await service.getJoinCode("game-1");
      await service.getJoinCode("game-1");
      await service.getJoinCode("game-1");

      expect(getGame).toHaveBeenCalledTimes(1);
    });

    it("does not cache a miss — retries the DB read when the game was absent", async () => {
      const cache = new GameCache();
      const getGame = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeGame({ joinCode: "H7K3" }));
      const repo = makeGameRepo({ getGame });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      expect(await service.getJoinCode("game-1")).toBeNull();
      expect(await service.getJoinCode("game-1")).toBe("H7K3");
      expect(getGame).toHaveBeenCalledTimes(2);
    });
  });

  describe("startGame", () => {
    it("initializes the engine, caches, and returns the initial state", async () => {
      const cache = new GameCache();
      const initialState = makeState("game-1", { status: "IN_PROGRESS" });
      const engine = makeEngine({
        initialize: vi.fn().mockReturnValue(initialState),
      });
      const factory = makeEngineFactory(engine);
      const game = makeGame({ playerIds: ["player-a", "player-b"] });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.startGame("game-1", "player-a");

      expect(result).toBe(initialState);
      expect(engine.initialize).toHaveBeenCalled();
      expect(repo.saveGame).toHaveBeenCalled();
      expect(cache.get("game-1")).toBe(initialState);
    });

    it("throws GAME_NOT_FOUND when the game does not exist", async () => {
      const cache = new GameCache();
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(null) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("missing", "player-a")).rejects.toThrow(
        "GAME_NOT_FOUND",
      );
    });

    it("throws GAME_ALREADY_STARTED when game is not in CREATED status", async () => {
      const cache = new GameCache();
      const game = makeGame({ status: "IN_PROGRESS" });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("game-1", "player-a")).rejects.toThrow(
        "GAME_ALREADY_STARTED",
      );
    });

    it("throws NOT_HOST when requester is not the first player", async () => {
      const cache = new GameCache();
      const game = makeGame({ playerIds: ["player-a", "player-b"] });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("game-1", "player-b")).rejects.toThrow(
        "NOT_HOST",
      );
    });

    it("throws NOT_ENOUGH_PLAYERS when only one player has joined", async () => {
      const cache = new GameCache();
      const game = makeGame({ playerIds: ["player-a"] });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("game-1", "player-a")).rejects.toThrow(
        "NOT_ENOUGH_PLAYERS",
      );
    });
  });

  describe("applyAction", () => {
    it("returns the new state and updates the cache on a valid action", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      cache.set("game-1", state);

      const newState = makeState("game-1", { version: 2 });
      const engine = makeEngine({
        applyAction: vi.fn().mockReturnValue({ success: true, newState }),
      });
      const factory = makeEngineFactory(engine);
      const game = makeGame({ status: "IN_PROGRESS" });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.applyAction("game-1", {
        type: "pass",
        playerId: "player-a",
      });

      expect(result).toBe(newState);
      expect(cache.get("game-1")).toBe(newState);
      expect(repo.saveGame).toHaveBeenCalled();
    });

    it("throws with the engine error message on an invalid action", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      cache.set("game-1", state);

      const engine = makeEngine({
        applyAction: vi.fn().mockReturnValue({
          success: false,
          newState: null,
          error: "Not your turn",
        }),
      });
      const factory = makeEngineFactory(engine);
      const repo = makeGameRepo();
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.applyAction("game-1", { type: "pass", playerId: "player-b" }),
      ).rejects.toThrow("Not your turn");

      // Cache must remain unchanged after a rejected action
      expect(cache.get("game-1")).toBe(state);
      expect(repo.saveGame).not.toHaveBeenCalled();
    });

    it("throws GAME_NOT_FOUND when no state exists", async () => {
      const cache = new GameCache();
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(null) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.applyAction("missing", { type: "pass", playerId: "player-a" }),
      ).rejects.toThrow("GAME_NOT_FOUND");
    });

    it("calls statsService.recordGameCompletion when game transitions to COMPLETED", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      cache.set("game-1", state);

      const completedState = makeState("game-1", {
        status: "COMPLETED",
        version: 2,
        winner: "player-a",
        scores: [
          { playerId: "player-a", score: 39 },
          { playerId: "player-b", score: -39 },
        ],
      });
      const engine = makeEngine({
        applyAction: vi
          .fn()
          .mockReturnValue({ success: true, newState: completedState }),
      });
      const factory = makeEngineFactory(engine);
      const game = makeGame({ status: "IN_PROGRESS" });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const statsService = makeStatsService();
      const service = new GameService(cache, factory, repo, statsService);

      await service.applyAction("game-1", {
        type: "playCards",
        playerId: "player-a",
      });

      expect(statsService.recordGameCompletion).toHaveBeenCalledWith(
        completedState,
      );
    });

    it("does not call statsService.recordGameCompletion for non-COMPLETED transitions", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      cache.set("game-1", state);

      const newState = makeState("game-1", {
        version: 2,
        status: "IN_PROGRESS",
      });
      const engine = makeEngine({
        applyAction: vi.fn().mockReturnValue({ success: true, newState }),
      });
      const factory = makeEngineFactory(engine);
      const game = makeGame({ status: "IN_PROGRESS" });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const statsService = makeStatsService();
      const service = new GameService(cache, factory, repo, statsService);

      await service.applyAction("game-1", {
        type: "pass",
        playerId: "player-a",
      });

      expect(statsService.recordGameCompletion).not.toHaveBeenCalled();
    });
  });

  describe("getPlayerView", () => {
    it("returns the filtered view for a specific player", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      cache.set("game-1", state);

      const expectedView = makePlayerView("game-1", "player-a");
      const engine = makeEngine({
        getPlayerView: vi.fn().mockReturnValue(expectedView),
      });
      const factory = makeEngineFactory(engine);
      const repo = makeGameRepo();
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getPlayerView("game-1", "player-a");

      expect(result).toBe(expectedView);
      expect(engine.getPlayerView).toHaveBeenCalledWith(state, "player-a");
    });

    it("returns null when the game has no state", async () => {
      const cache = new GameCache();
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(null) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getPlayerView("missing", "player-a");

      expect(result).toBeNull();
    });

    it("does not include other players' cards in the returned view", async () => {
      const cache = new GameCache();
      const state = makeState("game-1");
      cache.set("game-1", state);

      // View for player-a must only expose player-a's hand
      const viewForA = makePlayerView("game-1", "player-a");
      const engine = makeEngine({
        getPlayerView: vi.fn().mockReturnValue(viewForA),
      });
      const factory = makeEngineFactory(engine);
      const repo = makeGameRepo();
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.getPlayerView("game-1", "player-a");

      expect(result).not.toBeNull();
      // The view's `you` field must belong to player-a
      expect(result!.you.playerId).toBe("player-a");
      // The public player entries must not have a hand property
      for (const p of result!.players) {
        expect((p as Record<string, unknown>).hand).toBeUndefined();
      }
    });
  });
});
