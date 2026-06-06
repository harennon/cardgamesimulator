import type { Card } from "@shared/engine-types";
import type { ValidAction } from "@shared/engine-types";
import { compareCards } from "./constants.js";
import { detectHandType } from "./hand-detection.js";
import { beats } from "./hand-comparison.js";
import type { Big2Play, Big2State } from "./big2-types.js";
import type { HandType } from "./hand-types.js";

/**
 * Determine what action types the current player can take.
 * Returns action types, not every possible combination.
 */
export function computeValidActions(
  state: Big2State,
  hand: readonly Card[],
): readonly ValidAction[] {
  if (state.isFirstPlayOfGame) {
    return [
      {
        type: "playCards",
        description: "Play cards (must include lowest card)",
      },
    ];
  }

  if (state.isFreePlay) {
    return [{ type: "playCards", description: "Play any valid combination" }];
  }

  const canPlay =
    state.lastPlay != null && canBeatLastPlay(hand, state.lastPlay);

  if (canPlay) {
    return [
      { type: "playCards", description: "Play cards to beat current hand" },
      { type: "pass", description: "Pass" },
    ];
  }

  return [{ type: "pass", description: "Pass" }];
}

/**
 * Check if a specific play is valid given the current game state.
 */
export function isValidPlay(
  cards: readonly Card[],
  hand: readonly Card[],
  lastPlay: Big2Play | null,
  isFreePlay: boolean,
  isFirstPlayOfGame: boolean,
  lowestCard: Card,
): { valid: boolean; handType: HandType | null; error?: string } {
  // Check for duplicate cards in the play
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i] as Card;
      const b = cards[j] as Card;
      if (a.rank === b.rank && a.suit === b.suit) {
        return {
          valid: false,
          handType: null,
          error: "Duplicate cards in play.",
        };
      }
    }
  }

  // Check all played cards are in hand
  for (const card of cards) {
    const inHand = hand.some(
      (c) => c.rank === card.rank && c.suit === card.suit,
    );
    if (!inHand) {
      return { valid: false, handType: null, error: "Cards not in hand." };
    }
  }

  // Detect hand type
  const handType = detectHandType(cards);
  if (!handType) {
    return {
      valid: false,
      handType: null,
      error: "Invalid card combination.",
    };
  }

  // First play must include the lowest card
  if (isFirstPlayOfGame) {
    const includesLowest = cards.some(
      (c) => c.rank === lowestCard.rank && c.suit === lowestCard.suit,
    );
    if (!includesLowest) {
      return {
        valid: false,
        handType: null,
        error: `First play must include the ${lowestCard.rank} of ${lowestCard.suit}.`,
      };
    }
    return { valid: true, handType };
  }

  // Free play: any valid combination is allowed
  if (isFreePlay) {
    return { valid: true, handType };
  }

  // Must beat last play
  if (!lastPlay) {
    return { valid: true, handType };
  }

  // Must play the same number of cards
  if (cards.length !== lastPlay.cards.length) {
    return {
      valid: false,
      handType: null,
      error: "Must play same number of cards as current play.",
    };
  }

  if (!beats(handType, lastPlay.handType)) {
    return {
      valid: false,
      handType: null,
      error: "Play does not beat the current hand.",
    };
  }

  return { valid: true, handType };
}

/**
 * Returns true if the hand contains at least one combination that beats lastPlay.
 * Short-circuits on first found.
 */
export function canBeatLastPlay(
  hand: readonly Card[],
  lastPlay: Big2Play,
): boolean {
  const currentHandType = lastPlay.handType;

  if (currentHandType.kind === "single") {
    return hand.some((c) => {
      const ht = detectHandType([c]);
      return ht != null && beats(ht, currentHandType);
    });
  }

  if (currentHandType.kind === "pair") {
    // Find all pairs in hand
    const rankGroups = groupByRank(hand);
    for (const cards of Object.values(rankGroups)) {
      if (cards.length >= 2) {
        // Try all C(n,2) pairs for this rank
        for (let i = 0; i < cards.length; i++) {
          for (let j = i + 1; j < cards.length; j++) {
            const ht = detectHandType([cards[i] as Card, cards[j] as Card]);
            if (ht && beats(ht, currentHandType)) return true;
          }
        }
      }
    }
    return false;
  }

  // 5-card hands: check all C(n,5) combinations
  return hasBeating5CardCombo(hand, currentHandType);
}

function groupByRank(hand: readonly Card[]): Record<string, Card[]> {
  const groups: Record<string, Card[]> = {};
  for (const card of hand) {
    if (!groups[card.rank]) groups[card.rank] = [];
    (groups[card.rank] as Card[]).push(card);
  }
  return groups;
}

function hasBeating5CardCombo(
  hand: readonly Card[],
  currentHandType: HandType,
): boolean {
  const n = hand.length;
  if (n < 5) return false;

  // Iterate over all C(n,5) combinations
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const combo = [
              hand[a] as Card,
              hand[b] as Card,
              hand[c] as Card,
              hand[d] as Card,
              hand[e] as Card,
            ];
            const ht = detectHandType(combo);
            if (ht && beats(ht, currentHandType)) return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Sort cards by rank then suit (for display purposes).
 */
export function sortCards(cards: readonly Card[]): readonly Card[] {
  return [...cards].sort(compareCards);
}
