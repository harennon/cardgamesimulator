import type { APIRequestContext } from "@playwright/test";
import type {
  InternalGameState,
  GameStatus,
} from "../../src/shared/engine-types.js";
import type {
  SeedStateRequest,
  SeedStateResponse,
} from "../../src/backend/api/test/seedState.js";

const SEED_URL = "http://localhost:3000/test/seed-state";

/**
 * Seed a game into a specific state via the test API.
 * Call from Playwright tests to set up scenarios without playing through the game.
 */
export async function seedGameState(
  request: APIRequestContext,
  options: SeedStateRequest,
): Promise<void> {
  const res = await request.post(SEED_URL, { data: options });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`seedGameState failed (${res.status()}): ${body}`);
  }
  const body = (await res.json()) as SeedStateResponse;
  if (!body.success) {
    throw new Error(
      `seedGameState returned success:false for gameId=${options.gameId}`,
    );
  }
}

/**
 * Seed a completed game state with scores and winner.
 */
export async function seedCompletedGame(
  request: APIRequestContext,
  options: {
    gameId: string;
    players: Array<{ id: string; displayName: string }>;
    winner: string;
    scores: Array<{ playerId: string; score: number }>;
  },
): Promise<void> {
  const players = options.players.map((p) => ({
    playerId: p.id,
    displayName: p.displayName,
  }));

  // Build an empty-hands Big2 state for COMPLETED
  const emptyHands = options.players.map(() => [] as never[]);

  const state: Partial<InternalGameState> = {
    status: "COMPLETED" as GameStatus,
    players,
    winner: options.winner,
    scores: options.scores,
    currentPlayerIndex: -1,
    gameType: "big2",
    version: 1,
    turnNumber: 1,
    randomSeed: "test-seed-fixed",
    gameSpecificState: {
      hands: emptyHands,
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: options.players.map((_, i) => i),
    },
  };

  await seedGameState(request, {
    gameId: options.gameId,
    state,
    dbFields: {
      status: "COMPLETED",
      playerIds: options.players.map((p) => p.id),
      playerDisplayNames: Object.fromEntries(
        options.players.map((p) => [p.id, p.displayName]),
      ),
    },
  });
}
