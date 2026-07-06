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
  game.gameConfig = {};
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
    getGameByJoinCode: vi.fn().mockResolvedValue(null),
    saveGame: vi.fn().mockImplementation(async (g: Game) => g),
    clearJoinCode: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * An in-memory GameRepository that enforces the partial-unique-on-non-null
 * join_code constraint (mirrors migration 001_create_tables.sql idx_games_join_code).
 * Used to prove the rematch insert ordering: the old code must be cleared and
 * persisted before the new row is inserted with the freed code.
 */
function makeInMemoryRepo(seed: Game[] = []): GameRepository {
  const rows = new Map<string, Game>();
  for (const g of seed) rows.set(g.gameId, g);

  function assertJoinCodeUnique(gameId: string, joinCode: string | null): void {
    if (joinCode === null) return;
    for (const [id, g] of rows) {
      if (id !== gameId && g.joinCode === joinCode) {
        throw new Error(
          `duplicate key value violates unique constraint "idx_games_join_code"`,
        );
      }
    }
  }

  return {
    createGame: vi
      .fn()
      .mockImplementation(
        async (
          gameId: string,
          gameType: Game["gameType"],
          creatorId: string,
          maxPlayers: number,
          creatorDisplayName: string,
          turnTimerSeconds: number | null,
          joinCode: string | null,
          gameConfig: Game["gameConfig"] = {},
        ) => {
          assertJoinCodeUnique(gameId, joinCode);
          const game = new Game();
          game.gameId = gameId;
          game.gameType = gameType;
          game.playerIds = [creatorId];
          game.playerDisplayNames = { [creatorId]: creatorDisplayName };
          game.maxPlayers = maxPlayers;
          game.status = "CREATED";
          game.state = {};
          game.turnTimerSeconds = turnTimerSeconds;
          game.joinCode = joinCode;
          game.gameConfig = gameConfig;
          game.version = 1;
          rows.set(gameId, game);
          return game;
        },
      ),
    getGame: vi
      .fn()
      .mockImplementation(async (gameId: string) => rows.get(gameId) ?? null),
    getGameByJoinCode: vi.fn().mockImplementation(async (code: string) => {
      for (const g of rows.values()) {
        if (g.joinCode === code) return g;
      }
      return null;
    }),
    saveGame: vi.fn().mockImplementation(async (g: Game) => {
      assertJoinCodeUnique(g.gameId, g.joinCode);
      rows.set(g.gameId, g);
      return g;
    }),
    clearJoinCode: vi.fn().mockImplementation(async (gameId: string) => {
      const g = rows.get(gameId);
      if (g) g.joinCode = null;
    }),
  };
}

function makeCompletedGame(overrides: Partial<Game> = {}): Game {
  return makeGame({
    gameId: "old-game",
    status: "COMPLETED",
    playerIds: ["player-a", "player-b"],
    playerDisplayNames: { "player-a": "Alice", "player-b": "Bob" },
    joinCode: "H7K3",
    maxPlayers: 4,
    turnTimerSeconds: 30,
    ...overrides,
  });
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

    it("passes gameConfig.deckRoundsTarget into engine.initialize options", async () => {
      const cache = new GameCache();
      const initialize = vi
        .fn()
        .mockReturnValue(makeState("game-1", { status: "IN_PROGRESS" }));
      const engine = makeEngine({ initialize });
      const factory = makeEngineFactory(engine);
      // Tonk requires ≥3 players; use 3 to satisfy the engine-min guard.
      const game = makeGame({
        gameType: "tonk",
        playerIds: ["player-a", "player-b", "player-c"],
        gameConfig: { deckRoundsTarget: 6 },
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const service = new GameService(cache, factory, repo, makeStatsService());

      await service.startGame("game-1", "player-a");

      const config = initialize.mock.calls[0]![2] as {
        options: Record<string, unknown>;
      };
      expect(config.options.deckRoundsTarget).toBe(6);
    });

    it("falls back to 8 when gameConfig.deckRoundsTarget is absent", async () => {
      const cache = new GameCache();
      const initialize = vi
        .fn()
        .mockReturnValue(makeState("game-1", { status: "IN_PROGRESS" }));
      const engine = makeEngine({ initialize });
      const factory = makeEngineFactory(engine);
      const game = makeGame({
        playerIds: ["player-a", "player-b"],
        gameConfig: {},
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const service = new GameService(cache, factory, repo, makeStatsService());

      await service.startGame("game-1", "player-a");

      const config = initialize.mock.calls[0]![2] as {
        options: Record<string, unknown>;
      };
      expect(config.options.deckRoundsTarget).toBe(8);
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

  describe("createRematch", () => {
    // Engine whose initialize echoes back an IN_PROGRESS state for the gameId
    // it was given, so the new game's started state matches the new gameId.
    function makeRematchEngine(): GameEngine {
      return makeEngine({
        initialize: vi
          .fn()
          .mockImplementation((gameId: string) =>
            makeState(gameId, { status: "IN_PROGRESS" }),
          ),
      });
    }

    it("succeeds from a COMPLETED game — a new IN_PROGRESS game is started while the old stays COMPLETED", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame();
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId, state } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b"],
      );

      expect(newGameId).not.toBe("old-game");
      expect(state.status).toBe("IN_PROGRESS");

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.status).toBe("IN_PROGRESS");

      const reloadedOld = await repo.getGame("old-game");
      expect(reloadedOld?.status).toBe("COMPLETED");
    });

    it("transfers the join code: new game keeps the code, old game's code is cleared and persisted", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({ joinCode: "H7K3" });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.joinCode).toBe("H7K3");

      const reloadedOld = await repo.getGame("old-game");
      expect(reloadedOld?.joinCode).toBeNull();
      expect(repo.clearJoinCode).toHaveBeenCalledWith("old-game");

      // Resolving the code returns the new game, never the old one.
      const resolved = await repo.getGameByJoinCode("H7K3");
      expect(resolved?.gameId).toBe(newGameId);
    });

    it("clears the old code BEFORE inserting the new row (constraint regression)", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({ joinCode: "H7K3" });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      // The in-memory repo enforces the partial unique index — if createRematch
      // inserted before clearing, createGame would throw the duplicate error.
      await expect(
        service.createRematch("old-game", "player-a", ["player-a", "player-b"]),
      ).resolves.toBeDefined();
    });

    it("documents the collision: inserting the new row before clearing the old code throws a unique violation", async () => {
      const oldGame = makeCompletedGame({ joinCode: "H7K3" });
      const repo = makeInMemoryRepo([oldGame]);

      // Inserting a second row with the same non-null code while the old row
      // still holds it must collide.
      await expect(
        repo.createGame("new-game", "big2", "player-a", 4, "Alice", 30, "H7K3"),
      ).rejects.toThrow(/unique|duplicate/);
    });

    it("is idempotent: a second rematch of the same finished game throws REMATCH_ALREADY_STARTED", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({ joinCode: "H7K3" });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await service.createRematch("old-game", "player-a", [
        "player-a",
        "player-b",
      ]);

      const createCallsAfterFirst = (
        repo.createGame as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      await expect(
        service.createRematch("old-game", "player-a", ["player-a", "player-b"]),
      ).rejects.toThrow("REMATCH_ALREADY_STARTED");

      // No second new game was created.
      expect(
        (repo.createGame as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(createCallsAfterFirst);
    });

    it("mutates the joinCodeCache: getJoinCode(old) is null, getJoinCode(new) is the transferred code without an extra DB read", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({ joinCode: "H7K3" });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b"],
      );

      const getGameCallsBefore = (repo.getGame as ReturnType<typeof vi.fn>).mock
        .calls.length;

      expect(await service.getJoinCode("old-game")).toBeNull();
      expect(await service.getJoinCode(newGameId)).toBe("H7K3");

      // Both reads were served from the seeded cache — no extra getGame calls.
      expect((repo.getGame as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        getGameCallsBefore,
      );
    });

    it("throws GAME_NOT_FOUND when the old game does not exist", async () => {
      const cache = new GameCache();
      const repo = makeInMemoryRepo([]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("missing", "player-a", ["player-a", "player-b"]),
      ).rejects.toThrow("GAME_NOT_FOUND");
    });

    it("throws GAME_NOT_FINISHED when the old game is not COMPLETED", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({ status: "IN_PROGRESS" });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-a", ["player-a", "player-b"]),
      ).rejects.toThrow("GAME_NOT_FINISHED");
    });

    it("throws NOT_HOST when the requester is not the first player; no new game persisted", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame();
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-b", ["player-a", "player-b"]),
      ).rejects.toThrow("NOT_HOST");

      expect(repo.createGame).not.toHaveBeenCalled();
      expect(repo.clearJoinCode).not.toHaveBeenCalled();
    });

    it("throws NOT_ENOUGH_PLAYERS when only one connected player remains; old code stays intact", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({ joinCode: "H7K3" });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-a", ["player-a"]),
      ).rejects.toThrow("NOT_ENOUGH_PLAYERS");

      // Early throw must not clear the old code (still re-clickable).
      expect(repo.clearJoinCode).not.toHaveBeenCalled();
      const reloadedOld = await repo.getGame("old-game");
      expect(reloadedOld?.joinCode).toBe("H7K3");
    });

    it("carries over only connected players, host first, preserving order and display names", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", "player-b", "player-c"],
        playerDisplayNames: {
          "player-a": "Alice",
          "player-b": "Bob",
          "player-c": "Carol",
        },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      // player-b departed; connected roster arrives in arbitrary order.
      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-c", "player-a"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.playerIds).toEqual(["player-a", "player-c"]);
      expect(newGame?.playerDisplayNames).toEqual({
        "player-a": "Alice",
        "player-c": "Carol",
      });
    });

    it("carries a guest player into the new game unchanged", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", "guest-xyz"],
        playerDisplayNames: { "player-a": "Alice", "guest-xyz": "GuestBob" },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "guest-xyz"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.playerIds).toContain("guest-xyz");
      expect(newGame?.playerDisplayNames["guest-xyz"]).toBe("GuestBob");
    });

    it("carries the old game's gameConfig into the new createGame call (preserves deck length)", async () => {
      const cache = new GameCache();
      // Tonk requires ≥3 players; use 3 to satisfy the engine-min guard.
      const oldGame = makeCompletedGame({
        gameType: "tonk",
        playerIds: ["player-a", "player-b", "player-c"],
        playerDisplayNames: {
          "player-a": "Alice",
          "player-b": "Bob",
          "player-c": "Carol",
        },
        gameConfig: { deckRoundsTarget: 6 },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b", "player-c"],
      );

      // The 8th createGame arg is the carried-over gameConfig (practice/aiPlayerIds stripped).
      const createArgs = (repo.createGame as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(createArgs[7]).toEqual({ deckRoundsTarget: 6 });

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.gameConfig).toEqual({ deckRoundsTarget: 6 });
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
        false,
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

  // ---------------------------------------------------------------------------
  // LLD 118: startGame — relaxed start gate
  // ---------------------------------------------------------------------------

  describe("startGame — AI-seat / human-count guards", () => {
    it("1 human + 1 AI for Big2 (total 2) → starts; AI seat has a hand", async () => {
      const cache = new GameCache();
      const aiId = "ai:00000000-0000-0000-0000-000000000001";
      const initialState = makeState("game-1", {
        status: "IN_PROGRESS",
        players: [
          { playerId: "player-a", displayName: "Alice" },
          { playerId: aiId, displayName: "CPU 1" },
        ],
      });
      const engine = makeEngine({
        initialize: vi.fn().mockReturnValue(initialState),
      });
      const factory = makeEngineFactory(engine);
      const game = makeGame({
        gameType: "big2",
        playerIds: ["player-a", aiId],
        gameConfig: { practice: true, aiPlayerIds: [aiId] },
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.startGame("game-1", "player-a");

      expect(result.status).toBe("IN_PROGRESS");
      expect(result.players).toHaveLength(2);
      expect(result.players.some((p) => p.playerId === aiId)).toBe(true);
    });

    it("0 humans + N AI → throws NO_HUMAN_PLAYERS", async () => {
      const cache = new GameCache();
      const aiId1 = "ai:00000000-0000-0000-0000-000000000001";
      const aiId2 = "ai:00000000-0000-0000-0000-000000000002";
      const game = makeGame({
        gameType: "big2",
        playerIds: [aiId1, aiId2],
        gameConfig: { practice: true, aiPlayerIds: [aiId1, aiId2] },
      });
      // Host check uses playerIds[0]; we pass that as requesterId
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("game-1", aiId1)).rejects.toThrow(
        "NO_HUMAN_PLAYERS",
      );
    });

    it("1 human + 1 AI for Tonk (total 2) → throws NOT_ENOUGH_PLAYERS", async () => {
      const cache = new GameCache();
      const aiId = "ai:00000000-0000-0000-0000-000000000001";
      const game = makeGame({
        gameType: "tonk",
        playerIds: ["player-a", aiId],
        gameConfig: { practice: true, aiPlayerIds: [aiId] },
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("game-1", "player-a")).rejects.toThrow(
        "NOT_ENOUGH_PLAYERS",
      );
    });

    it("1 human + 2 AI for Tonk (total 3) → starts", async () => {
      const cache = new GameCache();
      const aiId1 = "ai:00000000-0000-0000-0000-000000000001";
      const aiId2 = "ai:00000000-0000-0000-0000-000000000002";
      const initialState = makeState("game-1", {
        status: "IN_PROGRESS",
        players: [
          { playerId: "player-a", displayName: "Alice" },
          { playerId: aiId1, displayName: "CPU 1" },
          { playerId: aiId2, displayName: "CPU 2" },
        ],
      });
      const engine = makeEngine({
        initialize: vi.fn().mockReturnValue(initialState),
      });
      const factory = makeEngineFactory(engine);
      const game = makeGame({
        gameType: "tonk",
        playerIds: ["player-a", aiId1, aiId2],
        gameConfig: { practice: true, aiPlayerIds: [aiId1, aiId2] },
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.startGame("game-1", "player-a");

      expect(result.status).toBe("IN_PROGRESS");
      expect(result.players).toHaveLength(3);
    });

    it("regression: 2 humans, no AI, Big2 → starts exactly as before", async () => {
      const cache = new GameCache();
      const initialState = makeState("game-1", { status: "IN_PROGRESS" });
      const engine = makeEngine({
        initialize: vi.fn().mockReturnValue(initialState),
      });
      const factory = makeEngineFactory(engine);
      const game = makeGame({
        gameType: "big2",
        playerIds: ["player-a", "player-b"],
        gameConfig: {},
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.startGame("game-1", "player-a");

      expect(result.status).toBe("IN_PROGRESS");
    });

    it("regression: 1 human, no AI, Big2 → still throws NOT_ENOUGH_PLAYERS", async () => {
      const cache = new GameCache();
      const game = makeGame({
        gameType: "big2",
        playerIds: ["player-a"],
        gameConfig: {},
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("game-1", "player-a")).rejects.toThrow(
        "NOT_ENOUGH_PLAYERS",
      );
    });

    it("regression: 2 humans, no AI, Tonk → still throws NOT_ENOUGH_PLAYERS (Tonk min 3)", async () => {
      const cache = new GameCache();
      const game = makeGame({
        gameType: "tonk",
        playerIds: ["player-a", "player-b"],
        gameConfig: {},
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.startGame("game-1", "player-a")).rejects.toThrow(
        "NOT_ENOUGH_PLAYERS",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // LLD 118: addAiSeats
  // ---------------------------------------------------------------------------

  describe("addAiSeats", () => {
    it("seats count AI ids (plain UUID), sets practice=true, populates aiPlayerIds, adds display names, persists", async () => {
      const cache = new GameCache();
      const game = makeGame({
        playerIds: ["player-a"],
        playerDisplayNames: { "player-a": "Alice" },
        maxPlayers: 4,
        gameConfig: {},
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const result = await service.addAiSeats("game-1", 2);

      expect(result.playerIds).toHaveLength(3);
      const aiIds = result.gameConfig.aiPlayerIds!;
      expect(aiIds).toHaveLength(2);
      // AI seat ids are plain UUIDs (no prefix) — compatible with the UUID[] column.
      // Identity is signalled by membership in gameConfig.aiPlayerIds, not by id format.
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const aiId of aiIds) {
        expect(aiId).toMatch(uuidPattern);
        expect(result.playerIds).toContain(aiId);
        // LLD 128: names now come from the AI_NAME_POOL, not "CPU N".
        expect(result.playerDisplayNames[aiId]).toBeTruthy();
        expect(result.playerDisplayNames[aiId]).not.toMatch(/^CPU \d+$/);
      }
      expect(result.gameConfig.practice).toBe(true);
      expect(repo.saveGame).toHaveBeenCalled();
    });

    it("count exceeding maxPlayers - current → throws GAME_FULL", async () => {
      const cache = new GameCache();
      const game = makeGame({
        playerIds: ["player-a", "player-b"],
        maxPlayers: 3,
        gameConfig: {},
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.addAiSeats("game-1", 2)).rejects.toThrow(
        "GAME_FULL",
      );
    });

    it("called on non-CREATED game → throws GAME_ALREADY_STARTED", async () => {
      const cache = new GameCache();
      const game = makeGame({ status: "IN_PROGRESS", gameConfig: {} });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.addAiSeats("game-1", 1)).rejects.toThrow(
        "GAME_ALREADY_STARTED",
      );
    });

    it("count < 1 → throws INVALID_AI_COUNT", async () => {
      const cache = new GameCache();
      const game = makeGame({ gameConfig: {} });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.addAiSeats("game-1", 0)).rejects.toThrow(
        "INVALID_AI_COUNT",
      );
    });

    it("game not found → throws GAME_NOT_FOUND", async () => {
      const cache = new GameCache();
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(null) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(service.addAiSeats("missing", 1)).rejects.toThrow(
        "GAME_NOT_FOUND",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // LLD 118: isAiSeat — memoization invariant
  // ---------------------------------------------------------------------------

  describe("isAiSeat", () => {
    it("returns true for a seated AI id and false for a human id (after IN_PROGRESS)", async () => {
      const cache = new GameCache();
      const aiId = "ai:00000000-0000-0000-0000-000000000001";
      const game = makeGame({
        status: "IN_PROGRESS",
        playerIds: ["player-a", aiId],
        gameConfig: { practice: true, aiPlayerIds: [aiId] },
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      expect(await service.isAiSeat("game-1", aiId)).toBe(true);
      expect(await service.isAiSeat("game-1", "player-a")).toBe(false);
    });

    it("returns false for an unknown id", async () => {
      const cache = new GameCache();
      const aiId = "ai:00000000-0000-0000-0000-000000000001";
      const game = makeGame({
        status: "IN_PROGRESS",
        playerIds: ["player-a", aiId],
        gameConfig: { practice: true, aiPlayerIds: [aiId] },
      });
      const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
      const factory = makeEngineFactory(makeEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      expect(await service.isAiSeat("game-1", "unknown-player")).toBe(false);
    });

    it("memoization invariant: isAiSeat called during CREATED does not cache; all AI ids visible after game transitions to IN_PROGRESS", async () => {
      const cache = new GameCache();
      const factory = makeEngineFactory(makeEngine());

      // Simulate: game starts with 1 AI (CREATED), then a second AI is added,
      // then game transitions to IN_PROGRESS. The repo is a mutable reference.
      let currentGame = makeGame({
        gameType: "big2",
        status: "CREATED",
        playerIds: ["player-a", "ai:first"],
        playerDisplayNames: {
          "player-a": "Alice",
          "ai:first": "CPU 1",
        },
        gameConfig: { practice: true, aiPlayerIds: ["ai:first"] },
      });
      const repo = makeGameRepo({
        getGame: vi.fn().mockImplementation(async () => currentGame),
        saveGame: vi.fn().mockImplementation(async (g: Game) => {
          currentGame = g;
          return g;
        }),
      });
      const service = new GameService(cache, factory, repo, makeStatsService());

      // Read during CREATED — should return true but must NOT cache (status=CREATED).
      expect(await service.isAiSeat("game-1", "ai:first")).toBe(true);

      // Simulate addAiSeats: add a second AI while still CREATED.
      currentGame = Object.assign(
        Object.create(Object.getPrototypeOf(currentGame)) as Game,
        currentGame,
        {
          playerIds: [...currentGame.playerIds, "ai:second"],
          playerDisplayNames: {
            ...currentGame.playerDisplayNames,
            "ai:second": "CPU 2",
          },
          gameConfig: {
            ...currentGame.gameConfig,
            aiPlayerIds: ["ai:first", "ai:second"],
          },
        },
      );

      // Transition to IN_PROGRESS (as startGame would do).
      currentGame = Object.assign(
        Object.create(Object.getPrototypeOf(currentGame)) as Game,
        currentGame,
        {
          status: "IN_PROGRESS",
        },
      );

      // Both AI ids must now be visible — proving the CREATED read did not
      // cache an incomplete set that would miss "ai:second".
      expect(await service.isAiSeat("game-1", "ai:first")).toBe(true);
      expect(await service.isAiSeat("game-1", "ai:second")).toBe(true);
      expect(await service.isAiSeat("game-1", "player-a")).toBe(false);

      // After IN_PROGRESS, subsequent reads are served from the memo (no extra DB read).
      const callsBefore = (repo.getGame as ReturnType<typeof vi.fn>).mock.calls
        .length;
      expect(await service.isAiSeat("game-1", "ai:first")).toBe(true);
      expect((repo.getGame as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callsBefore,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // LLD 140: createRematch — practice game re-seats AI
  // ---------------------------------------------------------------------------

  describe("createRematch — practice AI re-seating (LLD 140)", () => {
    // Real engines needed so addAiSeats (called internally) exercises the full
    // flow including the GAME_FULL and INVALID_AI_COUNT guards.
    function makeRematchEngine(): GameEngine {
      return makeEngine({
        initialize: vi
          .fn()
          .mockImplementation((gameId: string) =>
            makeState(gameId, { status: "IN_PROGRESS" }),
          ),
      });
    }

    // (a) REQUIRED regression — 1-human + N-CPU Big2 practice rematch succeeds.
    it("(a) 1-human + 2-CPU Big2 practice rematch succeeds: new game IN_PROGRESS with 3 seats, fresh AI ids, practice=true", async () => {
      const cache = new GameCache();
      const ai1 = "00000000-0000-0000-0000-000000000001";
      const ai2 = "00000000-0000-0000-0000-000000000002";
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", ai1, ai2],
        playerDisplayNames: {
          "player-a": "Alice",
          [ai1]: "CPU 1",
          [ai2]: "CPU 2",
        },
        gameConfig: { practice: true, aiPlayerIds: [ai1, ai2] },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId, state } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a"], // only the host is connected; AI never hold sockets
      );

      expect(newGameId).not.toBe("old-game");
      expect(state.status).toBe("IN_PROGRESS");

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.playerIds).toHaveLength(3);
      expect(newGame?.playerIds[0]).toBe("player-a"); // host first
      expect(newGame?.gameConfig.practice).toBe(true);
      expect(newGame?.gameConfig.aiPlayerIds).toHaveLength(2);
      // Fresh ids: not equal to old ai1 / ai2
      expect(newGame?.gameConfig.aiPlayerIds).not.toContain(ai1);
      expect(newGame?.gameConfig.aiPlayerIds).not.toContain(ai2);
    });

    // (b) REQUIRED regression — 2-human + 1-CPU mixed practice rematch succeeds.
    it("(b) 2-human + 1-CPU mixed Big2 practice rematch: new roster = 2 humans + 1 fresh AI, practice=true", async () => {
      const cache = new GameCache();
      const ai1 = "00000000-0000-0000-0000-000000000001";
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", "player-b", ai1],
        playerDisplayNames: {
          "player-a": "Alice",
          "player-b": "Bob",
          [ai1]: "CPU 1",
        },
        gameConfig: { practice: true, aiPlayerIds: [ai1] },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.playerIds).toHaveLength(3);
      expect(newGame?.playerIds).toContain("player-a");
      expect(newGame?.playerIds).toContain("player-b");
      expect(newGame?.gameConfig.practice).toBe(true);
      expect(newGame?.gameConfig.aiPlayerIds).toHaveLength(1);
      expect(newGame?.gameConfig.aiPlayerIds![0]).not.toBe(ai1); // fresh id
    });

    // Re-seat count matches the old game.
    it("old game with 3 AI seats → new game also has 3 fresh AI seats", async () => {
      const cache = new GameCache();
      const aiIds = [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000003",
      ];
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", ...aiIds],
        playerDisplayNames: Object.fromEntries([
          ["player-a", "Alice"],
          ...aiIds.map((id, i) => [id, `CPU ${i + 1}`]),
        ]),
        maxPlayers: 4,
        gameConfig: { practice: true, aiPlayerIds: aiIds },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.gameConfig.aiPlayerIds).toHaveLength(3);
    });

    // Roster-total guard — practice game below engine min.
    it("1-human + 1-CPU Tonk practice (total 2 < min 3) → NOT_ENOUGH_PLAYERS; old code intact", async () => {
      const cache = new GameCache();
      const ai1 = "00000000-0000-0000-0000-000000000001";
      const oldGame = makeCompletedGame({
        gameType: "tonk",
        playerIds: ["player-a", ai1],
        playerDisplayNames: { "player-a": "Alice", [ai1]: "CPU 1" },
        joinCode: "H7K3",
        gameConfig: { practice: true, aiPlayerIds: [ai1] },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-a", ["player-a"]),
      ).rejects.toThrow("NOT_ENOUGH_PLAYERS");

      // Early throw — old code intact (re-clickable)
      expect(repo.clearJoinCode).not.toHaveBeenCalled();
      const reloadedOld = await repo.getGame("old-game");
      expect(reloadedOld?.joinCode).toBe("H7K3");
    });

    it("1-human + 2-CPU Tonk practice (total 3 = min 3) → succeeds", async () => {
      const cache = new GameCache();
      const ai1 = "00000000-0000-0000-0000-000000000001";
      const ai2 = "00000000-0000-0000-0000-000000000002";
      const oldGame = makeCompletedGame({
        gameType: "tonk",
        playerIds: ["player-a", ai1, ai2],
        playerDisplayNames: {
          "player-a": "Alice",
          [ai1]: "CPU 1",
          [ai2]: "CPU 2",
        },
        gameConfig: { practice: true, aiPlayerIds: [ai1, ai2] },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.playerIds).toHaveLength(3);
      expect(newGame?.gameConfig.practice).toBe(true);
    });

    // REQUIRED regression — human-only rematch unchanged.
    it("REQUIRED regression: 2-human Big2 human-only rematch succeeds; no practice/aiPlayerIds", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", "player-b"],
        playerDisplayNames: { "player-a": "Alice", "player-b": "Bob" },
        gameConfig: {},
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.gameConfig.practice).toBeUndefined();
      expect(newGame?.gameConfig.aiPlayerIds).toBeUndefined();
      expect(newGame?.playerIds).toEqual(
        expect.arrayContaining(["player-a", "player-b"]),
      );
    });

    // REQUIRED regression — human-only Big2 solo still rejected.
    it("REQUIRED regression: 1 connected human, no AI, Big2 → NOT_ENOUGH_PLAYERS", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", "player-b"],
        playerDisplayNames: { "player-a": "Alice", "player-b": "Bob" },
        gameConfig: {},
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-a", ["player-a"]),
      ).rejects.toThrow("NOT_ENOUGH_PLAYERS");
    });

    // Tonk human-only tightening (Edge Case 7).
    it("Tonk human-only tightening: 2 connected humans, no AI → NOT_ENOUGH_PLAYERS (Tonk min 3)", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        gameType: "tonk",
        playerIds: ["player-a", "player-b", "player-c"],
        playerDisplayNames: {
          "player-a": "Alice",
          "player-b": "Bob",
          "player-c": "Carol",
        },
        gameConfig: {},
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-a", ["player-a", "player-b"]),
      ).rejects.toThrow("NOT_ENOUGH_PLAYERS");
    });

    // maxPlayers headroom (Edge Case 5).
    it("maxPlayers headroom: 1 human + 3 AI in a 4-slot game re-seats without GAME_FULL", async () => {
      const cache = new GameCache();
      const aiIds = [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000003",
      ];
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", ...aiIds],
        playerDisplayNames: Object.fromEntries([
          ["player-a", "Alice"],
          ...aiIds.map((id, i) => [id, `CPU ${i + 1}`]),
        ]),
        maxPlayers: 4,
        gameConfig: { practice: true, aiPlayerIds: aiIds },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-a", ["player-a"]),
      ).resolves.toBeDefined();
    });

    // Idempotency unchanged (Edge Case 9).
    it("idempotency: second createRematch for the same practice game → REMATCH_ALREADY_STARTED", async () => {
      const cache = new GameCache();
      const ai1 = "00000000-0000-0000-0000-000000000001";
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", ai1],
        playerDisplayNames: { "player-a": "Alice", [ai1]: "CPU 1" },
        joinCode: "H7K3",
        gameConfig: { practice: true, aiPlayerIds: [ai1] },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await service.createRematch("old-game", "player-a", ["player-a"]);

      await expect(
        service.createRematch("old-game", "player-a", ["player-a"]),
      ).rejects.toThrow("REMATCH_ALREADY_STARTED");
    });

    // Practice flag but empty aiPlayerIds (Edge Case 8).
    it("practice=true but aiPlayerIds=[] with 1 human → NOT_ENOUGH_PLAYERS (treated as human-only)", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        playerIds: ["player-a"],
        playerDisplayNames: { "player-a": "Alice" },
        gameConfig: { practice: true, aiPlayerIds: [] },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      await expect(
        service.createRematch("old-game", "player-a", ["player-a"]),
      ).rejects.toThrow("NOT_ENOUGH_PLAYERS");
    });

    it("practice=true but aiPlayerIds=[] with 2 humans → succeeds as human-only (no addAiSeats call)", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        playerIds: ["player-a", "player-b"],
        playerDisplayNames: { "player-a": "Alice", "player-b": "Bob" },
        gameConfig: { practice: true, aiPlayerIds: [] },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b"],
      );

      const newGame = await repo.getGame(newGameId);
      // addAiSeats was not called, so no AI re-seating
      expect(newGame?.gameConfig.aiPlayerIds).toBeUndefined();
      expect(newGame?.playerIds).toHaveLength(2);
    });

    // deckRoundsTarget preserved through practice rematch.
    it("Tonk practice rematch preserves deckRoundsTarget", async () => {
      const cache = new GameCache();
      const ai1 = "00000000-0000-0000-0000-000000000001";
      const ai2 = "00000000-0000-0000-0000-000000000002";
      const oldGame = makeCompletedGame({
        gameType: "tonk",
        playerIds: ["player-a", ai1, ai2],
        playerDisplayNames: {
          "player-a": "Alice",
          [ai1]: "CPU 1",
          [ai2]: "CPU 2",
        },
        gameConfig: {
          practice: true,
          aiPlayerIds: [ai1, ai2],
          deckRoundsTarget: 5,
        },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.gameConfig.deckRoundsTarget).toBe(5);
      expect(newGame?.gameConfig.practice).toBe(true);
    });

    // regression: human-only Tonk rematch preserves deckRoundsTarget, no practice added.
    it("regression: human-vs-human Tonk rematch preserves deckRoundsTarget, no practice added", async () => {
      const cache = new GameCache();
      const oldGame = makeCompletedGame({
        gameType: "tonk",
        playerIds: ["player-a", "player-b", "player-c"],
        playerDisplayNames: {
          "player-a": "Alice",
          "player-b": "Bob",
          "player-c": "Carol",
        },
        gameConfig: { deckRoundsTarget: 7 },
      });
      const repo = makeInMemoryRepo([oldGame]);
      const factory = makeEngineFactory(makeRematchEngine());
      const service = new GameService(cache, factory, repo, makeStatsService());

      const { newGameId } = await service.createRematch(
        "old-game",
        "player-a",
        ["player-a", "player-b", "player-c"],
      );

      const newGame = await repo.getGame(newGameId);
      expect(newGame?.gameConfig.deckRoundsTarget).toBe(7);
      expect(newGame?.gameConfig.practice).toBeUndefined();
      expect(newGame?.gameConfig.aiPlayerIds).toBeUndefined();
    });
  });
});
