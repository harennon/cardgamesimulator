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
