import type { Suit, Rank, Card } from "@shared/engine-types";

// Suit ranking: clubs (lowest) < diamonds < hearts < spades (highest)
export const SUIT_ORDER: readonly Suit[] = [
  "clubs",
  "diamonds",
  "hearts",
  "spades",
];

// Rank ranking: 3 (lowest) through 2 (highest)
export const RANK_ORDER: readonly Rank[] = [
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

export function rankValue(rank: Rank): number {
  return RANK_ORDER.indexOf(rank);
}

export function suitValue(suit: Suit): number {
  return SUIT_ORDER.indexOf(suit);
}

// Compare two cards. Returns negative if a < b, 0 if equal, positive if a > b.
// Primary sort: rank. Secondary sort: suit.
export function compareCards(a: Card, b: Card): number {
  const rankDiff = rankValue(a.rank) - rankValue(b.rank);
  if (rankDiff !== 0) return rankDiff;
  return suitValue(a.suit) - suitValue(b.suit);
}

export const THREE_OF_CLUBS: Card = { rank: "3", suit: "clubs" };

// Full 52-card deck ordered by suit then rank (generated once, immutable)
export const FULL_DECK: readonly Card[] = SUIT_ORDER.flatMap((suit) =>
  RANK_ORDER.map((rank) => ({ suit, rank })),
);

// Placement points by player count and finishing position (0-indexed)
export const PLACEMENT_POINTS: Record<number, readonly number[]> = {
  2: [5, 0],
  3: [5, 3, 0],
  4: [5, 3, 1, 0],
};
