import type { TonkCard, TonkTurnPhase } from "./tonk-types.js";
import type { TonkAction } from "./tonk-types.js";
import { cardValue, handValue, compareTonkCards } from "./constants.js";
import { isJoker } from "@shared/tonk-types.js";

export interface TonkPolicyView {
  readonly turnPhase: TonkTurnPhase;
  readonly tonkGateOpen: boolean;
  readonly drawableDiscard: TonkCard | null;
  readonly stockCount: number;
}

/** Hand value at/below which the AI calls TONK (conservative threshold). */
export const TONK_CALL_THRESHOLD = 10;

/**
 * Choose a Tonk move for an AI seat. Pure and deterministic — inspects only
 * myHand and the public view; never touches other seats' hands.
 *
 * Returns a TonkAction that is always legal in the state that produced `pub`.
 */
export function chooseTonkMove(
  myHand: readonly TonkCard[],
  pub: TonkPolicyView,
  playerId: string,
): TonkAction {
  if (pub.turnPhase === "draw") {
    return chooseDrawAction(myHand, pub, playerId);
  }
  return chooseDiscardAction(myHand, pub, playerId);
}

// ---------------------------------------------------------------------------
// D1. Discard phase
// ---------------------------------------------------------------------------

function chooseDiscardAction(
  myHand: readonly TonkCard[],
  pub: TonkPolicyView,
  playerId: string,
): TonkAction {
  // D1.1: Call TONK when gate is open and hand value is at/below threshold
  if (pub.tonkGateOpen && handValue(myHand) <= TONK_CALL_THRESHOLD) {
    return { type: "callTonk", playerId };
  }

  // D1.2: Discard to minimize hand value
  const bestGroup = chooseBestDiscardGroup(myHand);
  return { type: "discard", playerId, cards: bestGroup };
}

/**
 * Select the group of same-rank cards to discard that removes the most total
 * point value. Ties broken by higher card value, then by compareTonkCards.
 *
 * Never discards jokers unless the hand is entirely jokers.
 */
function chooseBestDiscardGroup(myHand: readonly TonkCard[]): TonkCard[] {
  // Group cards by rank (jokers form their own group)
  const groups = groupByRank(myHand);

  // Filter out joker group unless the hand is all jokers
  const nonJokerGroups = groups.filter((g) => !isJoker(g[0]!));
  const candidateGroups = nonJokerGroups.length > 0 ? nonJokerGroups : groups;

  if (candidateGroups.length === 0) {
    // Degenerate: empty hand — should never happen in a live game
    return myHand.length > 0 ? [myHand[0]!] : [];
  }

  // Score each group: total point value removed
  let bestGroup = candidateGroups[0]!;
  let bestScore = groupScore(bestGroup);

  for (let i = 1; i < candidateGroups.length; i++) {
    const g = candidateGroups[i]!;
    const score = groupScore(g);
    if (score > bestScore) {
      bestGroup = g;
      bestScore = score;
    } else if (score === bestScore) {
      // Tie-break: prefer the group with the higher per-card value (same, since
      // all ranks have same value); then by compareTonkCards on the lowest card.
      const bestLowest = groupLowest(bestGroup);
      const gLowest = groupLowest(g);
      if (compareTonkCards(gLowest, bestLowest) < 0) {
        bestGroup = g;
        bestScore = score;
      }
    }
  }

  return bestGroup;
}

function groupByRank(hand: readonly TonkCard[]): TonkCard[][] {
  const jokers = hand.filter((c) => isJoker(c));
  const byRank: Record<string, TonkCard[]> = {};
  for (const c of hand) {
    if (isJoker(c)) continue;
    const rank = (c as { rank: string }).rank;
    if (!byRank[rank]) byRank[rank] = [];
    byRank[rank]!.push(c);
  }
  const groups: TonkCard[][] = Object.values(byRank);
  if (jokers.length > 0) groups.push(jokers);
  return groups;
}

function groupScore(group: TonkCard[]): number {
  return group.reduce((sum, c) => sum + cardValue(c), 0);
}

function groupLowest(group: TonkCard[]): TonkCard {
  return group.reduce((low, c) => (compareTonkCards(c, low) < 0 ? c : low));
}

// ---------------------------------------------------------------------------
// D2. Draw phase
// ---------------------------------------------------------------------------

function chooseDrawAction(
  myHand: readonly TonkCard[],
  pub: TonkPolicyView,
  playerId: string,
): TonkAction {
  // D2.2: If stock is empty, only legal draw is stock (engine handles stock-out)
  if (pub.stockCount === 0) {
    return { type: "draw", playerId, source: "stock" };
  }

  // D2.1: Draw from discard only when it strictly lowers the hand
  if (pub.drawableDiscard !== null) {
    const drawableValue = cardValue(pub.drawableDiscard);
    const minHeldValue = myHand.reduce(
      (min, c) => Math.min(min, cardValue(c)),
      Infinity,
    );
    if (drawableValue < minHeldValue) {
      return { type: "draw", playerId, source: "discard" };
    }
  }

  return { type: "draw", playerId, source: "stock" };
}
