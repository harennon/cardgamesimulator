import type { Suit, Rank, Card } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";

// Standard suit ordering for a stable, deterministic card order.
export const SUIT_ORDER: readonly Suit[] = [
  "clubs",
  "diamonds",
  "hearts",
  "spades",
];

// Rank ordering used for stable card ordering and deck construction.
// (Tonk has no rank-based comparison; this is purely for deterministic ordering.)
export const RANK_ORDER: readonly Rank[] = [
  "A",
  "2",
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
];

/** Point value of a single card. Ace=1, 2–10=face, J/Q/K=10, Joker=0. */
export function cardValue(card: TonkCard): number {
  if (isJoker(card)) return 0;
  switch (card.rank) {
    case "A":
      return 1;
    case "J":
    case "Q":
    case "K":
      return 10;
    default:
      return Number(card.rank);
  }
}

/** Sum of point values of all cards in a hand (jokers contribute 0). */
export function handValue(hand: readonly TonkCard[]): number {
  return hand.reduce((sum, c) => sum + cardValue(c), 0);
}

/** True if two Tonk cards are the same instance (suit+rank for standard cards, joker id for jokers). */
export function tonkCardEquals(a: TonkCard, b: TonkCard): boolean {
  const aJoker = isJoker(a);
  const bJoker = isJoker(b);
  if (aJoker || bJoker) {
    return aJoker && bJoker && a.id === b.id;
  }
  return a.suit === b.suit && a.rank === b.rank;
}

/**
 * Stable, total ordering over Tonk cards used for deterministic tie-breaks
 * (e.g. auto-timeout highest-card selection). Standard cards order before
 * jokers; standard cards by (rank, suit); jokers by id.
 */
export function compareTonkCards(a: TonkCard, b: TonkCard): number {
  const aJoker = isJoker(a);
  const bJoker = isJoker(b);
  if (aJoker && bJoker) return a.id - b.id;
  if (aJoker) return 1; // jokers sort after standard cards
  if (bJoker) return -1;
  const rankDiff = RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
  if (rankDiff !== 0) return rankDiff;
  return SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit);
}

/** A single standard 52-card deck (no jokers), ordered by suit then rank. */
const ONE_STANDARD_DECK: readonly Card[] = SUIT_ORDER.flatMap((suit) =>
  RANK_ORDER.map((rank) => ({ suit, rank })),
);

/**
 * Build the ordered (unshuffled) pool for `numDecks` decks: each deck is
 * 52 standard cards + 2 jokers. Joker ids are unique across the whole pool
 * (0..2*numDecks-1) so duplicate cards in multi-deck pools remain distinct.
 */
export function buildOrderedPool(numDecks: number): readonly TonkCard[] {
  const pool: TonkCard[] = [];
  for (let d = 0; d < numDecks; d++) {
    for (const c of ONE_STANDARD_DECK) {
      pool.push({ suit: c.suit, rank: c.rank });
    }
  }
  for (let j = 0; j < 2 * numDecks; j++) {
    pool.push({ joker: true, id: j });
  }
  return pool;
}

/**
 * Compute the deterministic cut amount per §8.1:
 *   handCardsDealt = 5 * players
 *   poolSize       = 54 * numDecks
 *   targetCards    = handCardsDealt + deckRoundsTarget * players
 *   cutAmount      = max(0, poolSize - clamp(targetCards, [handCardsDealt + players, poolSize]))
 */
export function cutAmount(
  players: number,
  numDecks: number,
  deckRoundsTarget: number,
): number {
  const handCardsDealt = 5 * players;
  const poolSize = 54 * numDecks;
  const targetRaw = handCardsDealt + deckRoundsTarget * players;
  const lo = handCardsDealt + players;
  const hi = poolSize;
  const targetClamped = Math.min(hi, Math.max(lo, targetRaw));
  return Math.max(0, poolSize - targetClamped);
}

export function clampDeckRoundsTarget(raw: number): number {
  return Math.min(12, Math.max(5, raw));
}
