import type {
  InternalGameState,
  GameStatus,
  GameType,
  PlayerInfo,
  PlayerScore,
  Card,
} from "../../src/shared/engine-types.js";
import type { Big2State } from "../../src/backend/engine/big2/big2-types.js";
import { SeededPRNG } from "../../src/backend/engine/prng.js";
import { buildDeck } from "../../src/backend/engine/big2/deck.js";

/**
 * Partial state that callers provide. All fields optional except gameId.
 * The helper fills defaults for anything not specified.
 */
export interface SeedGameOptions {
  gameId: string;
  status?: GameStatus;
  gameType?: GameType;
  players?: PlayerInfo[];
  currentPlayerIndex?: number;
  turnNumber?: number;
  winner?: string | null;
  scores?: PlayerScore[] | null;
  /** If provided, placed into gameSpecificState.hands (Big2State) */
  hands?: Card[][];
  gameSpecificState?: Partial<Big2State>;
}

function makeDefaultPlayers(count: number): PlayerInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    playerId: `player-${i + 1}-default-id`,
    displayName: `Player ${i + 1}`,
  }));
}

/**
 * Build a complete InternalGameState from partial options.
 * Ensures all invariants hold (card counts, player indices, etc.)
 */
export function buildGameState(options: SeedGameOptions): InternalGameState {
  const status: GameStatus = options.status ?? "IN_PROGRESS";
  const gameType: GameType = options.gameType ?? "big2";
  const players: PlayerInfo[] = options.players ?? makeDefaultPlayers(4);

  let hands: readonly (readonly Card[])[];
  if (options.hands) {
    hands = options.hands;
  } else {
    // Use fixed seed so hands are deterministic
    const prng = new SeededPRNG("test-seed-fixed");
    const { hands: dealtHands } = buildDeck(players.length, prng);
    hands = dealtHands;
  }

  if (status === "COMPLETED") {
    if (!options.winner) {
      throw new Error(
        "buildGameState: winner is required when status=COMPLETED",
      );
    }
    if (!options.scores) {
      throw new Error(
        "buildGameState: scores is required when status=COMPLETED",
      );
    }
  }

  const defaultBig2State: Big2State = {
    hands,
    lastPlay: null,
    lastPlayPlayerIndex: null,
    consecutivePasses: 0,
    isFreePlay: true,
    isFirstPlayOfGame: true,
    playHistory: [],
    finishedPlayerIndices: [],
    trickStartIndex: 0,
  };

  const big2State: Big2State = {
    ...defaultBig2State,
    ...(options.gameSpecificState ?? {}),
    // hands from SeedGameOptions.hands takes precedence over gameSpecificState.hands
    hands: options.gameSpecificState?.hands ?? hands,
  };

  return {
    gameId: options.gameId,
    gameType,
    status,
    version: 1,
    players,
    currentPlayerIndex: options.currentPlayerIndex ?? 0,
    turnNumber: options.turnNumber ?? 1,
    gameSpecificState: big2State,
    winner: options.winner ?? null,
    scores: options.scores ?? null,
    randomSeed: "test-seed-fixed",
  };
}

/**
 * Build a COMPLETED game state with scores.
 * Convenience wrapper for game-over scenarios.
 */
export function buildCompletedState(options: {
  gameId: string;
  players: PlayerInfo[];
  winner: string;
  scores: PlayerScore[];
}): InternalGameState {
  const emptyHands: Card[][] = options.players.map(() => []);
  return buildGameState({
    gameId: options.gameId,
    status: "COMPLETED",
    players: options.players,
    winner: options.winner,
    scores: options.scores,
    hands: emptyHands,
    currentPlayerIndex: -1,
  });
}
