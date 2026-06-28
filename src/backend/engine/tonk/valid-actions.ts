import type { ValidAction } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types.js";
import { isJoker } from "@shared/tonk-types.js";
import type { TonkState } from "./tonk-types.js";
import { isTonkGateOpen } from "./turn.js";

/**
 * Action TYPES the current player may take, by phase (LLD 65 §6.2).
 * Specific discard cards / draw source are validated in applyAction.
 */
export function computeValidActions(
  state: TonkState,
  playerCount: number,
): readonly ValidAction[] {
  if (state.turnPhase === "draw") {
    return [{ type: "draw", description: "Draw one card" }];
  }

  // discard phase
  if (isTonkGateOpen(state.trickTurnCount, playerCount)) {
    return [
      { type: "discard", description: "Discard one or more same-rank cards" },
      { type: "callTonk", description: "Call TONK" },
    ];
  }
  return [
    { type: "discard", description: "Discard one or more same-rank cards" },
  ];
}

/**
 * Validate a discard payload against the player's hand. All cards must be the
 * same rank (jokers group only with jokers) and present in hand.
 */
export function validateDiscard(
  cards: readonly TonkCard[],
  hand: readonly TonkCard[],
): { valid: boolean; error?: string } {
  if (cards.length === 0) {
    return { valid: false, error: "Must discard at least one card." };
  }

  if (!sameRank(cards)) {
    return { valid: false, error: "Discard must be a single rank." };
  }

  // Each discarded card must be removable from a fresh copy of the hand
  // (handles duplicates correctly in multi-deck pools).
  const remaining = [...hand];
  for (const card of cards) {
    const idx = remaining.findIndex((h) => cardsEqual(h, card));
    if (idx < 0) {
      return { valid: false, error: "Cards not in hand." };
    }
    remaining.splice(idx, 1);
  }

  return { valid: true };
}

/** True if every card shares a rank (jokers group only with jokers). */
function sameRank(cards: readonly TonkCard[]): boolean {
  const first = cards[0]!;
  if (isJoker(first)) {
    return cards.every((c) => isJoker(c));
  }
  return cards.every((c) => !isJoker(c) && c.rank === first.rank);
}

/** Identity for hand removal: jokers match by id, standard cards by rank+suit. */
export function cardsEqual(a: TonkCard, b: TonkCard): boolean {
  const aJoker = isJoker(a);
  const bJoker = isJoker(b);
  if (aJoker || bJoker) {
    return aJoker && bJoker && a.id === b.id;
  }
  return a.rank === b.rank && a.suit === b.suit;
}
