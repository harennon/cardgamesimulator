import type {
  Card,
  InternalGameState,
  PlayerInfo,
} from "../../../src/shared/engine-types.js";
import type {
  TonkCard,
  TonkTurnPhase,
} from "../../../src/shared/tonk-types.js";
import type { TonkState } from "../../../src/backend/engine/tonk/tonk-types.js";

export function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

export function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

export function joker(id: number): TonkCard {
  return { joker: true, id };
}

export interface MakeTonkOpts {
  players?: readonly PlayerInfo[];
  hands: readonly (readonly TonkCard[])[];
  stock?: readonly TonkCard[];
  discardPile?: readonly TonkCard[];
  drawableDiscard?: TonkCard | null;
  turnPhase?: TonkTurnPhase;
  trickNumber?: number;
  trickTurnCount?: number;
  tallies?: readonly number[];
  currentPlayerIndex?: number;
  deckRoundsTarget?: number;
  numDecks?: number;
  lastDiscardCount?: number;
  lastDiscardPlayerIndex?: number | null;
  version?: number;
  turnNumber?: number;
  randomSeed?: string;
}

/**
 * Direct-state-manipulation helper (testing-principle #4). Constructs a full
 * InternalGameState wrapping a TonkState with sensible defaults so each test
 * builds exactly the precondition it needs. trickDeckSize is auto-computed from
 * hands + stock + discardPile so the conservation invariant starts satisfied.
 */
export function makeTonkState(opts: MakeTonkOpts): InternalGameState {
  const players = opts.players ?? opts.hands.map((_, i) => player(`p${i + 1}`));
  const stock = opts.stock ?? [];
  const discardPile = opts.discardPile ?? [];
  const tallies = opts.tallies ?? players.map(() => 0);
  const trickDeckSize =
    opts.hands.flat().length + stock.length + discardPile.length;

  const tonkState: TonkState = {
    hands: opts.hands,
    stock,
    discardPile,
    drawableDiscard: opts.drawableDiscard ?? null,
    lastDiscardCount: opts.lastDiscardCount ?? 0,
    lastDiscardPlayerIndex: opts.lastDiscardPlayerIndex ?? null,
    turnPhase: opts.turnPhase ?? "discard",
    trickNumber: opts.trickNumber ?? 1,
    trickTurnCount: opts.trickTurnCount ?? 0,
    trickDeckSize,
    tallies,
    deckRoundsTarget: opts.deckRoundsTarget ?? 8,
    numDecks: opts.numDecks ?? Math.ceil(players.length / 5),
    tonkCallerIndex: null,
    lostPlayerIndices: [],
    trueLoserIndex: null,
    log: [],
  };

  return {
    gameId: "test-game",
    gameType: "tonk",
    status: "IN_PROGRESS",
    version: opts.version ?? 1,
    players,
    currentPlayerIndex: opts.currentPlayerIndex ?? 0,
    turnNumber: opts.turnNumber ?? 1,
    gameSpecificState: tonkState,
    winner: null,
    scores: null,
    randomSeed: opts.randomSeed ?? "test-seed",
  };
}

export function tonkOf(state: InternalGameState): TonkState {
  return state.gameSpecificState as TonkState;
}

/** Total physical cards in play this trick (hands + stock + discardPile). */
export function totalCards(state: InternalGameState): number {
  const t = tonkOf(state);
  return t.hands.flat().length + t.stock.length + t.discardPile.length;
}
