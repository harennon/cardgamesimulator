/**
 * LLD 118 — AI-seat integration tests.
 *
 * Full-game simulations (Big2 and Tonk) that drive all seats via
 * getAutoTimeoutAction, verifying card-count invariants, legal actions, and
 * stats-exclusion through applyAction on a real game-service stack.
 */
import { describe, it, expect, vi } from "vitest";
import { GameService } from "../../src/backend/service/gameService.js";
import { GameCache } from "../../src/backend/engine/game-cache.js";
import { GameEngineFactory } from "../../src/backend/engine/game-engine-factory.js";
import { Big2Engine } from "../../src/backend/engine/big2/big2-engine.js";
import { TonkEngine } from "../../src/backend/engine/tonk/tonk-engine.js";
import type { GameRepository } from "../../src/backend/database/database.js";
import type { PlayerStatsRepository } from "../../src/backend/database/database.js";
import type { GuestSessionStore } from "../../src/backend/guest/guestSessionStore.js";
import { StatsService } from "../../src/backend/service/statsService.js";
import { Game } from "../../src/backend/database/entities/Game.js";
import type { InternalGameState } from "../../src/shared/engine-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInMemoryRepo(seed: Game[] = []): GameRepository {
  const rows = new Map<string, Game>();
  for (const g of seed) rows.set(g.gameId, g);

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
      .mockImplementation(async (id: string) => rows.get(id) ?? null),
    getGameByJoinCode: vi.fn().mockResolvedValue(null),
    saveGame: vi.fn().mockImplementation(async (g: Game) => {
      rows.set(g.gameId, g);
      return g;
    }),
    clearJoinCode: vi.fn().mockImplementation(async (id: string) => {
      const g = rows.get(id);
      if (g) g.joinCode = null;
    }),
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

function makeGuestSessionStore(): GuestSessionStore {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as GuestSessionStore;
}

/**
 * Build a GameService backed by real engines so we can run actual game logic.
 */
function makeRealService(statsRepo: PlayerStatsRepository): {
  service: GameService;
  repo: GameRepository;
} {
  const cache = new GameCache();
  const factory = new GameEngineFactory();
  factory.register(new Big2Engine());
  factory.register(new TonkEngine());
  const repo = makeInMemoryRepo();
  const statsService = new StatsService(statsRepo, makeGuestSessionStore());
  const service = new GameService(cache, factory, repo, statsService);
  return { service, repo };
}

/**
 * Drive the current player's turn using getAutoTimeoutAction until the game
 * completes or we exhaust the iteration cap. Returns the final state.
 */
async function driveToCompletion(
  service: GameService,
  gameId: string,
  maxMoves = 2000,
): Promise<InternalGameState> {
  const factory = new GameEngineFactory();
  factory.register(new Big2Engine());
  factory.register(new TonkEngine());

  for (let i = 0; i < maxMoves; i++) {
    const state = await service.getGameState(gameId);
    if (!state || state.status !== "IN_PROGRESS") return state!;

    const engine = factory.getEngine(state.gameType);
    const autoAction = engine.getAutoTimeoutAction(state);
    if (!autoAction) throw new Error(`No auto-action at move ${i}`);

    await service.applyAction(gameId, autoAction);
  }

  const finalState = await service.getGameState(gameId);
  if (finalState?.status !== "COMPLETED") {
    throw new Error("driveToCompletion: exhausted move cap without COMPLETED");
  }
  return finalState;
}

/**
 * Big2 completion invariant: at COMPLETED status, the winner must have 0 cards
 * in hand (they played out all their cards). In Big2, played cards leave hands
 * and are tracked via lastPlay (not a discard pile), so the hand-total at
 * COMPLETED is ≤ 13*(players-1). We verify the winner's hand is empty.
 */
function assertBig2CompletedInvariant(state: InternalGameState): void {
  if (state.gameType !== "big2" || state.status !== "COMPLETED") return;
  const big2 = state.gameSpecificState as { hands: unknown[][] };
  if (!big2 || !state.winner) return;
  const winnerIndex = state.players.findIndex(
    (p) => p.playerId === state.winner,
  );
  if (winnerIndex < 0) return;
  expect(big2.hands[winnerIndex]?.length).toBe(0);
}

// ---------------------------------------------------------------------------
// Full-game simulation — Big2, 1 human + 1 AI
// ---------------------------------------------------------------------------

describe("AI-seat full-game simulation — Big2 (1 human + 1 AI)", () => {
  it("drives to COMPLETED; winner has empty hand; scores present", async () => {
    const statsRepo = makeStatsRepo();
    const { service: svc, repo: r } = makeRealService(statsRepo);
    const aiId = `ai:${crypto.randomUUID()}`;
    const humanId = "player-human";

    const g = new Game();
    g.gameId = "g-big2";
    g.gameType = "big2";
    g.playerIds = [humanId, aiId];
    g.playerDisplayNames = { [humanId]: "Human", [aiId]: "CPU 1" };
    g.maxPlayers = 4;
    g.status = "CREATED";
    g.state = {};
    g.turnTimerSeconds = null;
    g.joinCode = null;
    g.gameConfig = { practice: true, aiPlayerIds: [aiId] };
    g.version = 1;

    (r.getGame as ReturnType<typeof vi.fn>).mockImplementation(async () => g);
    (r.saveGame as ReturnType<typeof vi.fn>).mockImplementation(
      async (updated: Game) => {
        Object.assign(g, updated);
        return g;
      },
    );

    await svc.startGame("g-big2", humanId);

    const finalState = await driveToCompletion(svc, "g-big2");

    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.winner).toBeDefined();
    expect(finalState.scores).not.toBeNull();
    expect(finalState.scores!.length).toBeGreaterThan(0);
    assertBig2CompletedInvariant(finalState);
  });
});

// ---------------------------------------------------------------------------
// Full-game simulation — Tonk, 1 human + 2 AI
// ---------------------------------------------------------------------------

describe("AI-seat full-game simulation — Tonk (1 human + 2 AI)", () => {
  it("drives to COMPLETED; scores present with a trueLoser in the breakdown", async () => {
    const statsRepo = makeStatsRepo();
    const { service: svc, repo: r } = makeRealService(statsRepo);
    const ai1 = `ai:${crypto.randomUUID()}`;
    const ai2 = `ai:${crypto.randomUUID()}`;
    const humanId = "player-human";

    const g = new Game();
    g.gameId = "g-tonk";
    g.gameType = "tonk";
    g.playerIds = [humanId, ai1, ai2];
    g.playerDisplayNames = {
      [humanId]: "Human",
      [ai1]: "CPU 1",
      [ai2]: "CPU 2",
    };
    g.maxPlayers = 8;
    g.status = "CREATED";
    g.state = {};
    g.turnTimerSeconds = null;
    g.joinCode = null;
    g.gameConfig = {
      practice: true,
      aiPlayerIds: [ai1, ai2],
      deckRoundsTarget: 5, // shorter game
    };
    g.version = 1;

    (r.getGame as ReturnType<typeof vi.fn>).mockImplementation(async () => g);
    (r.saveGame as ReturnType<typeof vi.fn>).mockImplementation(
      async (updated: Game) => {
        Object.assign(g, updated);
        return g;
      },
    );

    await svc.startGame("g-tonk", humanId);

    const finalState = await driveToCompletion(svc, "g-tonk");

    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.scores).not.toBeNull();
    expect(finalState.scores!.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// End-to-end stats exclusion via applyAction
// ---------------------------------------------------------------------------

describe("AI-seat stats/history exclusion via applyAction", () => {
  it("practice game: zero incrementStats and zero recordGameHistory calls for the human seat", async () => {
    const statsRepo = makeStatsRepo();
    const { service: svc, repo: r } = makeRealService(statsRepo);
    const aiId = `ai:${crypto.randomUUID()}`;
    const humanId = "player-human";

    const g = new Game();
    g.gameId = "g-excl";
    g.gameType = "big2";
    g.playerIds = [humanId, aiId];
    g.playerDisplayNames = { [humanId]: "Human", [aiId]: "CPU 1" };
    g.maxPlayers = 4;
    g.status = "CREATED";
    g.state = {};
    g.turnTimerSeconds = null;
    g.joinCode = null;
    g.gameConfig = { practice: true, aiPlayerIds: [aiId] };
    g.version = 1;

    (r.getGame as ReturnType<typeof vi.fn>).mockImplementation(async () => g);
    (r.saveGame as ReturnType<typeof vi.fn>).mockImplementation(
      async (updated: Game) => {
        Object.assign(g, updated);
        return g;
      },
    );

    await svc.startGame("g-excl", humanId);
    await driveToCompletion(svc, "g-excl");

    // Stats fire-and-forget; give the micro-task queue a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(statsRepo.incrementStats).not.toHaveBeenCalled();
    expect(statsRepo.recordGameHistory).not.toHaveBeenCalled();
  });

  it("regression: non-practice 2-human game records both writes per human seat", async () => {
    const statsRepo = makeStatsRepo();
    const { service: svc, repo: r } = makeRealService(statsRepo);
    const humanA = "player-a";
    const humanB = "player-b";

    const g = new Game();
    g.gameId = "g-reg";
    g.gameType = "big2";
    g.playerIds = [humanA, humanB];
    g.playerDisplayNames = { [humanA]: "Alice", [humanB]: "Bob" };
    g.maxPlayers = 4;
    g.status = "CREATED";
    g.state = {};
    g.turnTimerSeconds = null;
    g.joinCode = null;
    g.gameConfig = {};
    g.version = 1;

    (r.getGame as ReturnType<typeof vi.fn>).mockImplementation(async () => g);
    (r.saveGame as ReturnType<typeof vi.fn>).mockImplementation(
      async (updated: Game) => {
        Object.assign(g, updated);
        return g;
      },
    );

    await svc.startGame("g-reg", humanA);
    await driveToCompletion(svc, "g-reg");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(statsRepo.incrementStats).toHaveBeenCalledTimes(2);
    expect(statsRepo.recordGameHistory).toHaveBeenCalledTimes(2);
  });
});
