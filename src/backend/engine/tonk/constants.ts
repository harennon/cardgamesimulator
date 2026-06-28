import type { Rank, Suit } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types.js";
import { isJoker } from "@shared/tonk-types.js";

/** Point value of a single card. Ace=1, 2-10=face, J/Q/K=10, Joker=0. */
const RANK_VALUE: Record<Rank, number> = {
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 10,
  Q: 10,
  K: 10,
  A: 1,
  "2": 2,
};

export function cardValue(card: TonkCard): number {
  if (isJoker(card)) return 0;
  return RANK_VALUE[card.rank];
}

/** Sum of point values of all cards in a hand. Lower is better. */
export function handValue(hand: readonly TonkCard[]): number {
  return hand.reduce((sum, card) => sum + cardValue(card), 0);
}

/** Number of jokers per single 54-card deck. */
export const JOKERS_PER_DECK = 2;

/** deckRoundsTarget clamp range (LLD 65 §8.1, §8.8). */
export const MIN_DECK_ROUNDS_TARGET = 5;
export const MAX_DECK_ROUNDS_TARGET = 12;
export const DEFAULT_DECK_ROUNDS_TARGET = 8;

/** Match-end threshold: any tally >= 150 triggers end-of-game resolution. */
export const LOSE_THRESHOLD = 150;

/** Cards dealt to each player at trick start. */
export const HAND_SIZE = 5;

/** TONK Case B penalty and Case C stock-out penalty. */
export const TONK_PENALTY = 30;

// Deterministic stable card order for auto-timeout tie-break (LLD 69 §7).
// Fixed (rank, suit) ordering; jokers sort last. This is a total order over any
// pool of TonkCards so the auto-discard choice is fully reproducible from (state).
const RANK_TIEBREAK_ORDER: readonly Rank[] = [
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
];

const SUIT_TIEBREAK_ORDER: readonly Suit[] = [
  "clubs",
  "diamonds",
  "hearts",
  "spades",
];

/**
 * Total order over TonkCards used only for deterministic tie-breaking in
 * auto-timeout. Returns negative if a sorts before b. Jokers sort after all
 * standard cards, then by joker id.
 */
export function compareTonkCards(a: TonkCard, b: TonkCard): number {
  const aJoker = isJoker(a);
  const bJoker = isJoker(b);
  if (aJoker && bJoker) return a.id - b.id;
  if (aJoker) return 1;
  if (bJoker) return -1;

  const rankDiff =
    RANK_TIEBREAK_ORDER.indexOf(a.rank) - RANK_TIEBREAK_ORDER.indexOf(b.rank);
  if (rankDiff !== 0) return rankDiff;
  return (
    SUIT_TIEBREAK_ORDER.indexOf(a.suit) - SUIT_TIEBREAK_ORDER.indexOf(b.suit)
  );
}
