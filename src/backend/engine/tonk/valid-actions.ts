import type { ValidAction } from "@shared/engine-types";
import type { TonkCard, TonkDrawSource } from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";
import type { TonkState } from "./tonk-types.js";
import { tonkCardEquals } from "./constants.js";

/**
 * Action TYPES available to the current player given the phase and TONK gate
 * (§6.2). Returns types, not concrete discard combinations — the cards in a
 * discard payload are validated in applyAction.
 */
export function computeValidActions(
  state: TonkState,
  playerCount: number,
): readonly ValidAction[] {
  if (state.turnPhase === "discard") {
    const gateOpen = state.trickTurnCount >= playerCount;
    if (gateOpen) {
      return [
        { type: "discard", description: "Discard one or more same-rank cards" },
        { type: "callTonk", description: "Call TONK" },
      ];
    }
    return [
      { type: "discard", description: "Discard one or more same-rank cards" },
    ];
  }

  // draw phase
  const actions: ValidAction[] = [{ type: "draw", description: "stock" }];
  if (state.drawableDiscard !== null) {
    actions.push({ type: "draw", description: "discard" });
  }
  return actions;
}

/** Same-rank grouping for a discard: jokers group only with jokers. */
function sameRank(a: TonkCard, b: TonkCard): boolean {
  const aJoker = isJoker(a);
  const bJoker = isJoker(b);
  if (aJoker || bJoker) {
    return aJoker && bJoker;
  }
  return a.rank === b.rank;
}

export interface DiscardValidation {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Validate a discard payload against the player's hand (§8.2). Cards must be
 * non-empty, all the same rank (jokers only with jokers), and all present in
 * hand (accounting for duplicates in multi-deck pools via exact instance match).
 */
export function validateDiscard(
  cards: readonly TonkCard[],
  hand: readonly TonkCard[],
): DiscardValidation {
  if (cards.length === 0) {
    return { valid: false, error: "Must discard at least one card" };
  }

  const first = cards[0] as TonkCard;
  for (const c of cards) {
    if (!sameRank(first, c)) {
      return { valid: false, error: "Discard must be a single rank" };
    }
  }

  // Each discarded card must match a distinct card still in hand.
  const remaining = hand.slice();
  for (const c of cards) {
    const idx = remaining.findIndex((h) => tonkCardEquals(h, c));
    if (idx === -1) {
      return { valid: false, error: "Cards not in hand" };
    }
    remaining.splice(idx, 1);
  }

  return { valid: true };
}

export interface DrawValidation {
  readonly valid: boolean;
  readonly error?: string;
}

/** Validate a draw source against state (§8.3). */
export function validateDrawSource(
  source: TonkDrawSource,
  state: TonkState,
): DrawValidation {
  if (source !== "stock" && source !== "discard") {
    return { valid: false, error: "Invalid draw source" };
  }
  if (source === "discard" && state.drawableDiscard === null) {
    return { valid: false, error: "No card available to draw from discard" };
  }
  return { valid: true };
}
