/**
 * LLD 128 — addAiSeats naming tests.
 *
 * Verifies that AI seats are assigned names from the pool via aiNameForOrdinal,
 * not the old "CPU N" format, and that all other addAiSeats behaviour is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { GameService } from "../../src/backend/service/gameService.js";
import { GameCache } from "../../src/backend/engine/game-cache.js";
import type { GameRepository } from "../../src/backend/database/database.js";
import type { PlayerStatsRepository } from "../../src/backend/database/database.js";
import type { GuestSessionStore } from "../../src/backend/guest/guestSessionStore.js";
import type { GameEngineFactory } from "../../src/backend/engine/game-engine-factory.js";
import { StatsService } from "../../src/backend/service/statsService.js";
import { Game } from "../../src/backend/database/entities/Game.js";
import { aiNameForOrdinal } from "../../src/shared/aiNames.js";

// ---------------------------------------------------------------------------
// Helpers (minimal — mirrors the gameService.test.ts pattern)
// ---------------------------------------------------------------------------

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["player-a"];
  game.playerDisplayNames = { "player-a": "Alice" };
  game.maxPlayers = 8;
  game.status = "CREATED";
  game.state = {};
  game.gameConfig = {};
  game.version = 1;
  Object.assign(game, overrides);
  return game;
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

function makeStatsRepo(): PlayerStatsRepository {
  return {
    getStats: vi.fn().mockResolvedValue(null),
    getAllStats: vi.fn().mockResolvedValue([]),
    incrementStats: vi.fn().mockResolvedValue(undefined),
    recordGameHistory: vi.fn().mockResolvedValue(undefined),
    getWindowedStats: vi.fn().mockResolvedValue([]),
    getTrackingSince: vi.fn().mockResolvedValue(null),
  };
}

function makeEngineFactory(): GameEngineFactory {
  return {
    register: vi.fn(),
    getEngine: vi.fn(),
  } as unknown as GameEngineFactory;
}

function makeService(): GameService {
  const cache = new GameCache();
  const factory = makeEngineFactory();
  const statsService = new StatsService(makeStatsRepo(), {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as GuestSessionStore);
  const game = makeGame();
  const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
  return new GameService(cache, factory, repo, statsService);
}

// ---------------------------------------------------------------------------
// addAiSeats — names from pool (LLD 128)
// ---------------------------------------------------------------------------

describe("addAiSeats — names use AI_NAME_POOL via aiNameForOrdinal", () => {
  it("first 3 AI seats get Ace, Bishop, Cortex (ordinals 0, 1, 2)", async () => {
    const cache = new GameCache();
    const factory = makeEngineFactory();
    const game = makeGame({
      playerIds: ["player-a"],
      playerDisplayNames: { "player-a": "Alice" },
      maxPlayers: 8,
      gameConfig: {},
    });
    const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
    const statsService = new StatsService(makeStatsRepo(), {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as GuestSessionStore);
    const service = new GameService(cache, factory, repo, statsService);

    const result = await service.addAiSeats("game-1", 3);

    const aiIds = result.gameConfig.aiPlayerIds!;
    expect(aiIds).toHaveLength(3);
    expect(result.playerDisplayNames[aiIds[0]]).toBe(aiNameForOrdinal(0)); // Ace
    expect(result.playerDisplayNames[aiIds[1]]).toBe(aiNameForOrdinal(1)); // Bishop
    expect(result.playerDisplayNames[aiIds[2]]).toBe(aiNameForOrdinal(2)); // Cortex
  });

  it("no display name contains 'CPU ' (old format is gone)", async () => {
    const cache = new GameCache();
    const factory = makeEngineFactory();
    const game = makeGame({
      playerIds: ["player-a"],
      playerDisplayNames: { "player-a": "Alice" },
      maxPlayers: 8,
      gameConfig: {},
    });
    const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
    const statsService = new StatsService(makeStatsRepo(), {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as GuestSessionStore);
    const service = new GameService(cache, factory, repo, statsService);

    const result = await service.addAiSeats("game-1", 7);

    for (const id of result.gameConfig.aiPlayerIds!) {
      expect(result.playerDisplayNames[id]).not.toMatch(/^CPU /);
    }
  });

  it("ordinal is existingAiCount + i: second call adds seats starting at the right ordinal", async () => {
    const cache = new GameCache();
    const factory = makeEngineFactory();

    // Game already has 2 AI seats (ordinals 0 and 1: Ace, Bishop).
    const existingAi1 = "ai-existing-1";
    const existingAi2 = "ai-existing-2";
    const game = makeGame({
      playerIds: ["player-a", existingAi1, existingAi2],
      playerDisplayNames: {
        "player-a": "Alice",
        [existingAi1]: aiNameForOrdinal(0),
        [existingAi2]: aiNameForOrdinal(1),
      },
      maxPlayers: 8,
      gameConfig: {
        practice: true,
        aiPlayerIds: [existingAi1, existingAi2],
      },
    });
    const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
    const statsService = new StatsService(makeStatsRepo(), {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as GuestSessionStore);
    const service = new GameService(cache, factory, repo, statsService);

    const result = await service.addAiSeats("game-1", 2);

    const allAiIds = result.gameConfig.aiPlayerIds!;
    expect(allAiIds).toHaveLength(4);
    // The two newly-added AI ids (ordinals 2 and 3: Cortex, Domino)
    const newAiIds = allAiIds.slice(2);
    expect(result.playerDisplayNames[newAiIds[0]]).toBe(aiNameForOrdinal(2)); // Cortex
    expect(result.playerDisplayNames[newAiIds[1]]).toBe(aiNameForOrdinal(3)); // Domino
  });

  it("practice=true and aiPlayerIds still set correctly (regression: non-name behaviour unchanged)", async () => {
    const cache = new GameCache();
    const factory = makeEngineFactory();
    const game = makeGame({
      playerIds: ["player-a"],
      playerDisplayNames: { "player-a": "Alice" },
      maxPlayers: 4,
      gameConfig: {},
    });
    const repo = makeGameRepo({ getGame: vi.fn().mockResolvedValue(game) });
    const statsService = new StatsService(makeStatsRepo(), {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as GuestSessionStore);
    const service = new GameService(cache, factory, repo, statsService);

    const result = await service.addAiSeats("game-1", 2);

    expect(result.gameConfig.practice).toBe(true);
    expect(result.gameConfig.aiPlayerIds).toHaveLength(2);
    expect(result.playerIds).toHaveLength(3);
  });
});
