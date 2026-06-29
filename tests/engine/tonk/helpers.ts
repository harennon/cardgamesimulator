import type {
  InternalGameState,
  PlayerInfo,
  GameStatus,
} from "../../../src/shared/engine-types.js";
import type {
  TonkState,
  TonkCard,
} from "../../../src/backend/engine/tonk/tonk-types.js";
import { isJoker } from "../../../src/shared/tonk-types.js";

export function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

export function players(n: number): PlayerInfo[] {
  return Array.from({ length: n }, (_, i) => player(`p${i + 1}`));
}

/** Standard card constructor. */
export function c(
  rank:
    | "3"
    | "4"
    | "5"
    | "6"
    | "7"
    | "8"
    | "9"
    | "10"
    | "J"
    | "Q"
    | "K"
    | "A"
    | "2",
  suit: "clubs" | "diamonds" | "hearts" | "spades",
): TonkCard {
  return { rank, suit };
}

/** Joker constructor. */
export function j(id = 0): TonkCard {
  return { joker: true, id };
}

export interface TonkStateOverrides extends Partial<TonkState> {}

const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
const RANKS = [
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
] as const;

/** A deterministic pool of distinct standard cards (no jokers), length n. */
export function distinctCards(n: number): TonkCard[] {
  const out: TonkCard[] = [];
  let i = 0;
  while (out.length < n) {
    const suit = SUITS[i % SUITS.length]!;
    const rank = RANKS[Math.floor(i / SUITS.length) % RANKS.length]!;
    out.push({ rank, suit });
    i++;
  }
  return out;
}

/**
 * Construct a full InternalGameState with a directly-provided TonkState, so
 * tests can set preconditions without replaying turns (testing-principles #4).
 */
export function buildTonkState(opts: {
  playerCount: number;
  status?: GameStatus;
  currentPlayerIndex?: number;
  turnNumber?: number;
  version?: number;
  randomSeed?: string;
  tonk: TonkStateOverrides & {
    hands: readonly (readonly TonkCard[])[];
    stock: readonly TonkCard[];
  };
}): InternalGameState {
  const ps = players(opts.playerCount);
  const handCards = opts.tonk.hands.reduce((s, h) => s + h.length, 0);
  const stockCards = opts.tonk.stock.length;
  const discardCards = opts.tonk.discardPile?.length ?? 0;

  const tonkState: TonkState = {
    hands: opts.tonk.hands,
    stock: opts.tonk.stock,
    discardPile: opts.tonk.discardPile ?? [],
    drawableDiscard: opts.tonk.drawableDiscard ?? null,
    lastDiscardCount: opts.tonk.lastDiscardCount ?? 0,
    lastDiscardPlayerIndex: opts.tonk.lastDiscardPlayerIndex ?? null,
    turnPhase: opts.tonk.turnPhase ?? "discard",
    trickNumber: opts.tonk.trickNumber ?? 1,
    trickTurnCount: opts.tonk.trickTurnCount ?? 0,
    tallies: opts.tonk.tallies ?? ps.map(() => 0),
    tonkCallerIndex: opts.tonk.tonkCallerIndex ?? null,
    lostPlayerIndices: opts.tonk.lostPlayerIndices ?? [],
    trueLoserIndex: opts.tonk.trueLoserIndex ?? null,
    trickDeckSize:
      opts.tonk.trickDeckSize ?? handCards + stockCards + discardCards,
    log: opts.tonk.log ?? [],
  };

  return {
    gameId: "test-game",
    gameType: "tonk",
    status: opts.status ?? "IN_PROGRESS",
    version: opts.version ?? 1,
    players: ps,
    currentPlayerIndex: opts.currentPlayerIndex ?? 0,
    turnNumber: opts.turnNumber ?? 1,
    gameSpecificState: tonkState,
    winner: null,
    scores: null,
    randomSeed: opts.randomSeed ?? "test-seed",
  };
}

export function tonk(state: InternalGameState): TonkState {
  return state.gameSpecificState as TonkState;
}

/** Σ hands + stock + discardPile (card conservation within a trick). */
export function totalCards(state: InternalGameState): number {
  const ts = tonk(state);
  const inHands = ts.hands.reduce((s, h) => s + h.length, 0);
  return inHands + ts.stock.length + ts.discardPile.length;
}

export function countJokers(cards: readonly TonkCard[]): number {
  return cards.filter((card) => isJoker(card)).length;
}
