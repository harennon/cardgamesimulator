import type { Card } from "@shared/engine-types";
import { compareCards, rankValue } from "./constants.js";
import type { HandType } from "./hand-types.js";

/**
 * Detect what hand type a set of cards forms, or null if invalid.
 */
export function detectHandType(cards: readonly Card[]): HandType | null {
  if (cards.length === 1) {
    return { kind: "single", card: cards[0] as Card };
  }
  if (cards.length === 2) {
    return detectPair(cards);
  }
  if (cards.length === 5) {
    return detectFiveCard(cards);
  }
  return null;
}

function detectPair(cards: readonly Card[]): HandType | null {
  const [a, b] = cards as [Card, Card];
  if (a.rank !== b.rank) return null;
  const highCard = compareCards(a, b) >= 0 ? a : b;
  return { kind: "pair", rank: a.rank, highCard };
}

function detectFiveCard(cards: readonly Card[]): HandType | null {
  const sorted = [...cards].sort(compareCards);

  const straightFlush = tryDetectStraightFlush(sorted);
  if (straightFlush) return straightFlush;

  const fourOfAKind = tryDetectFourOfAKind(sorted);
  if (fourOfAKind) return fourOfAKind;

  const fullHouse = tryDetectFullHouse(sorted);
  if (fullHouse) return fullHouse;

  const straight = tryDetectStraight(sorted);
  if (straight) return straight;

  return null;
}

function isConsecutiveRanks(sorted: Card[]): boolean {
  // 2 cannot appear in a straight (rank index 12)
  for (const card of sorted) {
    if (card.rank === "2") return false;
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i] as Card;
    const next = sorted[i + 1] as Card;
    if (rankValue(next.rank) - rankValue(curr.rank) !== 1) return false;
  }
  return true;
}

function tryDetectStraightFlush(sorted: Card[]): HandType | null {
  if (!isConsecutiveRanks(sorted)) return null;
  const firstSuit = (sorted[0] as Card).suit;
  if (!sorted.every((c) => c.suit === firstSuit)) return null;
  const highCard = sorted[sorted.length - 1] as Card;
  return { kind: "straightFlush", highCard };
}

function tryDetectFourOfAKind(sorted: Card[]): HandType | null {
  // Groups: either first 4 same rank or last 4 same rank
  const rankCounts = getRankCounts(sorted);
  const quadRank = Object.entries(rankCounts).find(
    ([, count]) => count === 4,
  )?.[0];
  if (!quadRank) return null;
  const quadCards = sorted.filter((c) => c.rank === quadRank);
  const highCard = quadCards.reduce((best, c) =>
    compareCards(c, best) > 0 ? c : best,
  );
  return { kind: "fourOfAKind", quadRank, highCard };
}

function tryDetectFullHouse(sorted: Card[]): HandType | null {
  const rankCounts = getRankCounts(sorted);
  const entries = Object.entries(rankCounts);
  if (entries.length !== 2) return null;
  const tripleEntry = entries.find(([, count]) => count === 3);
  const pairEntry = entries.find(([, count]) => count === 2);
  if (!tripleEntry || !pairEntry) return null;
  const tripleRank = tripleEntry[0] as string;
  const tripleCards = sorted.filter((c) => c.rank === tripleRank);
  const highCard = tripleCards.reduce((best, c) =>
    compareCards(c, best) > 0 ? c : best,
  );
  return { kind: "fullHouse", tripleRank, highCard };
}

function tryDetectStraight(sorted: Card[]): HandType | null {
  if (!isConsecutiveRanks(sorted)) return null;
  const highCard = sorted[sorted.length - 1] as Card;
  return { kind: "straight", highCard };
}

function getRankCounts(cards: Card[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const card of cards) {
    counts[card.rank] = (counts[card.rank] ?? 0) + 1;
  }
  return counts;
}
