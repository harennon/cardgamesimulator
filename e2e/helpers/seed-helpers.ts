import type { APIRequestContext } from "@playwright/test";
import type {
  InternalGameState,
  GameStatus,
} from "../../src/shared/engine-types.js";
import type {
  SeedStateRequest,
  SeedStateResponse,
} from "../../src/backend/api/test/seedState.js";
import type { TonkState } from "../../src/backend/engine/tonk/tonk-types.js";
import type { TonkCard } from "../../src/shared/tonk-types.js";

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

/** Standard (non-joker) Tonk card constructor for building seed fixtures. */
export function tonkCard(rank: string, suit: string): TonkCard {
  return { rank, suit } as unknown as TonkCard;
}

/**
 * Build a valid in-progress TonkState for seeding. Defaults give a discard-phase
 * turn with healthy stock so an auto-draw never stocks out. Override any field
 * via `overrides` (e.g. tallies near LOSE_THRESHOLD, turnPhase: "draw").
 *
 * Mirrors the engine test helper (tests/engine/tonk/helpers.ts buildTonkState):
 * trickDeckSize defaults to the conserved card count when not overridden.
 */
export function buildTonkSeedState(
  playerCount: number,
  hands: TonkCard[][],
  overrides: Partial<TonkState> = {},
): TonkState {
  // Healthy stock so any auto-draw in a timed-out turn has a card to take.
  const stock: TonkCard[] =
    overrides.stock !== undefined
      ? [...overrides.stock]
      : Array.from({ length: 12 }, (_v, i) =>
          tonkCard(
            "5",
            (["clubs", "diamonds", "hearts", "spades"] as const)[i % 4]!,
          ),
        );
  const discardPile =
    overrides.discardPile !== undefined
      ? [...overrides.discardPile]
      : [tonkCard("3", "clubs")];
  const handCards = hands.reduce((s, h) => s + h.length, 0);

  return {
    hands,
    stock,
    discardPile,
    drawableDiscard:
      overrides.drawableDiscard !== undefined
        ? overrides.drawableDiscard
        : (discardPile[discardPile.length - 1] ?? null),
    lastDiscardCount: overrides.lastDiscardCount ?? 1,
    lastDiscardPlayerIndex: overrides.lastDiscardPlayerIndex ?? null,
    turnPhase: overrides.turnPhase ?? "discard",
    trickNumber: overrides.trickNumber ?? 1,
    trickTurnCount: overrides.trickTurnCount ?? 0,
    tallies: overrides.tallies ?? Array.from({ length: playerCount }, () => 0),
    tonkCallerIndex: overrides.tonkCallerIndex ?? null,
    lostPlayerIndices: overrides.lostPlayerIndices ?? [],
    trueLoserIndex: overrides.trueLoserIndex ?? null,
    trickDeckSize:
      overrides.trickDeckSize ?? handCards + stock.length + discardPile.length,
    log: overrides.log ?? [],
  };
}

/**
 * Seed a Tonk game into a specific IN_PROGRESS state via the test API.
 *
 * The seed endpoint merges over the started state (preserving players/randomSeed),
 * so this is used after a real createGame + game:start to overwrite the cached
 * TonkState with a deterministic precondition — the same pattern the integration
 * suite (tests/integration/tonk-timer-rearm.test.ts) uses, lifted to the browser
 * tier. Per testing-principles §4 (direct state manipulation over replay).
 */
export async function seedTonkState(
  request: APIRequestContext,
  options: {
    gameId: string;
    players: Array<{ id: string; displayName: string }>;
    currentPlayerIndex: number;
    tonk: TonkState;
    turnTimerSeconds?: number;
  },
): Promise<void> {
  const state: Partial<InternalGameState> = {
    status: "IN_PROGRESS" as GameStatus,
    currentPlayerIndex: options.currentPlayerIndex,
    gameType: "tonk",
    gameSpecificState: options.tonk,
  };

  const dbFields: NonNullable<SeedStateRequest["dbFields"]> = {
    status: "IN_PROGRESS",
    playerIds: options.players.map((p) => p.id),
    playerDisplayNames: Object.fromEntries(
      options.players.map((p) => [p.id, p.displayName]),
    ),
  };
  if (options.turnTimerSeconds !== undefined) {
    dbFields.turnTimerSeconds = options.turnTimerSeconds;
  }

  await seedGameState(request, { gameId: options.gameId, state, dbFields });
}
