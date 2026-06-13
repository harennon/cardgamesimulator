import type { HandType } from "@shared/big2-types";
export type { HandType };

/**
 * Five-card hand type hierarchy. Higher index beats lower index regardless of card values.
 */
export const FIVE_CARD_HIERARCHY: readonly string[] = [
  "straight",
  "fullHouse",
  "fourOfAKind",
  "straightFlush",
];

/** Number of cards required for each hand kind. */
export const HAND_SIZE: Record<HandType["kind"], number> = {
  single: 1,
  pair: 2,
  straight: 5,
  fullHouse: 5,
  fourOfAKind: 5,
  straightFlush: 5,
};
