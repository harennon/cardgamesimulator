import type { Card } from "@shared/engine-types";
import type { Big2Play, Big2Action } from "./big2-types.js";
import { compareCards, rankValue } from "./constants.js";
import { detectHandType } from "./hand-detection.js";
import { beats } from "./hand-comparison.js";

export interface Big2PolicyView {
  readonly lastPlay: Big2Play | null;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly lowestCard: Card;
  readonly consecutivePasses: number;
  readonly activePlayerCount: number;
}

/**
 * Choose a Big2 move for an AI seat. Pure and deterministic — inspects only
 * myHand and the public view; never touches other seats' hands.
 *
 * Returns a Big2Action that is always legal in the state that produced `pub`.
 */
export function chooseBig2Move(
  myHand: readonly Card[],
  pub: Big2PolicyView,
  playerId: string,
): Big2Action {
  if (pub.isFirstPlayOfGame) {
    return chooseFirstPlay(myHand, pub.lowestCard, playerId);
  }
  if (pub.isFreePlay) {
    return chooseFreePlay(myHand, playerId);
  }
  return chooseFollowPlay(myHand, pub, playerId);
}

// ---------------------------------------------------------------------------
// C1. First play of game
// ---------------------------------------------------------------------------

function chooseFirstPlay(
  myHand: readonly Card[],
  lowestCard: Card,
  playerId: string,
): Big2Action {
  const hand = [...myHand].sort(compareCards);

  // Prefer a 5-card combo containing the lowest card
  const fiveCardCombo = find5CardComboContaining(hand, lowestCard);
  if (fiveCardCombo) {
    return { type: "playCards", playerId, cards: fiveCardCombo };
  }

  // Prefer a pair containing the lowest card
  const pair = findPairContaining(hand, lowestCard);
  if (pair) {
    return { type: "playCards", playerId, cards: pair };
  }

  // Fall back to playing the lowest single (always legal on first play)
  return { type: "playCards", playerId, cards: [lowestCard] };
}

function find5CardComboContaining(
  sortedHand: Card[],
  target: Card,
): Card[] | null {
  const n = sortedHand.length;
  if (n < 5) return null;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const combo = [
              sortedHand[a]!,
              sortedHand[b]!,
              sortedHand[c]!,
              sortedHand[d]!,
              sortedHand[e]!,
            ];
            const containsTarget = combo.some(
              (c) => c.rank === target.rank && c.suit === target.suit,
            );
            if (containsTarget && detectHandType(combo) !== null) {
              return combo;
            }
          }
        }
      }
    }
  }
  return null;
}

function findPairContaining(sortedHand: Card[], target: Card): Card[] | null {
  for (const c of sortedHand) {
    if (c.rank === target.rank && !(c.suit === target.suit)) {
      // Found a rank-mate — return the pair with the lower card first
      const pair = [target, c].sort(compareCards);
      return pair;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// C2. Free play (must play, cannot pass)
// ---------------------------------------------------------------------------

function chooseFreePlay(myHand: readonly Card[], playerId: string): Big2Action {
  const hand = [...myHand].sort(compareCards);
  const truesSingletons = findTrueSingletons(hand);

  // Try 5-card combos first (shed the most cards, use the cheapest available)
  const bestFive = findBestFreePlayCombo(hand, 5);
  if (bestFive) {
    return { type: "playCards", playerId, cards: bestFive };
  }

  // Try pairs
  const bestPair = findBestFreePlayCombo(hand, 2);
  if (bestPair) {
    return { type: "playCards", playerId, cards: bestPair };
  }

  // Lead a single — pick the lowest true singleton, but never a 2 or A when
  // a lower singleton exists.
  const candidateSingles = truesSingletons.length > 0 ? truesSingletons : hand;
  const chosen = pickLeadSingle(candidateSingles);
  return { type: "playCards", playerId, cards: [chosen] };
}

/**
 * Cards that are NOT part of any same-rank group (pair/triple/quad) in hand.
 * A true singleton cannot be "broken up" because it has no partner.
 */
function findTrueSingletons(sortedHand: Card[]): Card[] {
  const rankCounts: Record<string, number> = {};
  for (const c of sortedHand) {
    rankCounts[c.rank] = (rankCounts[c.rank] ?? 0) + 1;
  }
  return sortedHand.filter((c) => rankCounts[c.rank] === 1);
}

function findBestFreePlayCombo(
  sortedHand: Card[],
  size: number,
): Card[] | null {
  const n = sortedHand.length;
  if (n < size) return null;

  // Enumerate all combinations of `size` cards
  const allCombos = getCombinations(sortedHand, size);
  const validCombos = allCombos.filter(
    (combo) => detectHandType(combo) !== null,
  );
  if (validCombos.length === 0) return null;

  if (size === 1) {
    // Not used via this path, but handle gracefully
    return validCombos[0]!;
  }

  if (size === 5) {
    // Choose the combo with the lowest high card
    return validCombos.reduce((best, combo) => {
      const bestHigh = comboHighCard(best);
      const comboHigh = comboHighCard(combo);
      return compareCards(comboHigh, bestHigh) < 0 ? combo : best;
    });
  }

  if (size === 2) {
    // Choose the lowest-rank pair (pairs are ranked by their high card).
    return validCombos.reduce((best, combo) => {
      const bestHigh = comboHighCard(best);
      const comboHigh = comboHighCard(combo);
      if (compareCards(comboHigh, bestHigh) !== 0) {
        return compareCards(comboHigh, bestHigh) < 0 ? combo : best;
      }
      return best;
    });
  }

  return validCombos[0]!;
}

/**
 * Pick the single to lead: lowest rank that isn't a 2 or A (when a lower option
 * exists). Also never lead a card that belongs to a pair/triple if a true
 * singleton is available.
 */
function pickLeadSingle(candidates: Card[]): Card {
  const sorted = [...candidates].sort(compareCards);

  // Never lead a 2 while a lower option exists
  const nonTwo = sorted.filter((c) => c.rank !== "2");
  if (nonTwo.length > 0) {
    // Never lead an A while a rank below A exists
    const belowAce = nonTwo.filter((c) => c.rank !== "A");
    if (belowAce.length > 0) {
      return belowAce[0]!;
    }
    return nonTwo[0]!;
  }
  return sorted[0]!;
}

function comboHighCard(combo: Card[]): Card {
  return combo.reduce((high, c) => (compareCards(c, high) > 0 ? c : high));
}

// ---------------------------------------------------------------------------
// C3. Following (not free play)
// ---------------------------------------------------------------------------

function chooseFollowPlay(
  myHand: readonly Card[],
  pub: Big2PolicyView,
  playerId: string,
): Big2Action {
  const lastPlay = pub.lastPlay!;

  // C3.1: If we cannot beat lastPlay, pass
  if (!canBeatLastPlayFromHand(myHand, lastPlay)) {
    return { type: "pass", playerId };
  }

  // Check if we should play or conserve
  const handSize = myHand.length;
  const closeToOut = handSize <= 5;

  // Find all beating combos
  const beatingCombos = findAllBeatingCombos(myHand, lastPlay);
  if (beatingCombos.length === 0) {
    return { type: "pass", playerId };
  }

  // Sort beating combos: prefer the cheapest (lowest high card)
  const sortedBeating = beatingCombos.sort((a, b) => {
    const aHigh = comboHighCard(a);
    const bHigh = comboHighCard(b);
    return compareCards(aHigh, bHigh);
  });

  const minimalBeatingCombo = sortedBeating[0]!;
  const cheapBeatingHighCard = comboHighCard(minimalBeatingCombo);

  // C3.2: Decide whether to play
  const wouldWinTrick = pub.consecutivePasses >= pub.activePlayerCount - 2; // all other active players already passed
  const isCheapBeat = rankValue(cheapBeatingHighCard.rank) <= rankValue("J");

  if (closeToOut || isCheapBeat || wouldWinTrick) {
    // Play the minimal (cheapest) beating combo, honoring combo-preservation
    const chosenCombo = chooseMinimalBeating(
      [...myHand].sort(compareCards),
      sortedBeating,
    );
    return { type: "playCards", playerId, cards: chosenCombo };
  }

  // Otherwise pass to conserve expensive cards
  return { type: "pass", playerId };
}

function canBeatLastPlayFromHand(
  hand: readonly Card[],
  lastPlay: Big2Play,
): boolean {
  const size = lastPlay.cards.length;
  const combos = getCombinations([...hand].sort(compareCards), size);
  for (const combo of combos) {
    const ht = detectHandType(combo);
    if (ht && beats(ht, lastPlay.handType)) return true;
  }
  return false;
}

function findAllBeatingCombos(
  hand: readonly Card[],
  lastPlay: Big2Play,
): Card[][] {
  const size = lastPlay.cards.length;
  const sorted = [...hand].sort(compareCards);
  const combos = getCombinations(sorted, size);
  return combos.filter((combo) => {
    const ht = detectHandType(combo);
    return ht != null && beats(ht, lastPlay.handType);
  });
}

/**
 * Among beating combos, pick the minimal one while respecting the
 * combo-preservation guard: don't break up a pair to lead a single if a
 * true singleton that also beats is available.
 */
function chooseMinimalBeating(
  sortedHand: Card[],
  sortedBeatingCombos: Card[][],
): Card[] {
  if (sortedBeatingCombos[0]!.length !== 1) {
    // For pairs and 5-card combos, just take the cheapest
    return sortedBeatingCombos[0]!;
  }

  // Single card play: prefer a true singleton over a card that belongs to a pair
  const trueSingletons = findTrueSingletons(sortedHand);
  if (trueSingletons.length > 0) {
    // Among the beating singles, prefer those that are true singletons
    const beatingSingletons = sortedBeatingCombos.filter((combo) =>
      trueSingletons.some(
        (ts) => ts.rank === combo[0]!.rank && ts.suit === combo[0]!.suit,
      ),
    );
    if (beatingSingletons.length > 0) {
      return beatingSingletons[0]!;
    }
  }

  return sortedBeatingCombos[0]!;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getCombinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  if (k === arr.length) return [arr];
  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, k - 1).map((combo) => [
    first!,
    ...combo,
  ]);
  const withoutFirst = getCombinations(rest, k);
  return [...withFirst, ...withoutFirst];
}
