import type { Rank } from "@shared/engine-types";
import { compareCards, rankValue } from "./constants.js";
import { FIVE_CARD_HIERARCHY } from "./hand-types.js";
import type { HandType } from "./hand-types.js";

/**
 * Returns true if challenger beats current.
 * Both must be the same "size class" (same number of cards).
 * For 5-card hands, a higher category always beats a lower category.
 */
export function beats(challenger: HandType, current: HandType): boolean {
  if (challenger.kind !== current.kind) {
    // Cross-category: only valid for 5-card hands
    const challengerIdx = FIVE_CARD_HIERARCHY.indexOf(challenger.kind);
    const currentIdx = FIVE_CARD_HIERARCHY.indexOf(current.kind);
    if (challengerIdx === -1 || currentIdx === -1) {
      // Different sizes (e.g. single vs pair) — not a valid comparison
      return false;
    }
    return challengerIdx > currentIdx;
  }

  switch (challenger.kind) {
    case "single":
      return (
        current.kind === "single" &&
        compareCards(challenger.card, current.card) > 0
      );

    case "pair":
      if (current.kind !== "pair") return false;
      if (
        rankValue(challenger.rank as Rank) !== rankValue(current.rank as Rank)
      ) {
        return (
          rankValue(challenger.rank as Rank) > rankValue(current.rank as Rank)
        );
      }
      // Same rank: compare high cards by suit
      return compareCards(challenger.highCard, current.highCard) > 0;

    case "straight":
    case "straightFlush":
      if (current.kind !== challenger.kind) return false;
      return compareCards(challenger.highCard, current.highCard) > 0;

    case "fullHouse":
      if (current.kind !== "fullHouse") return false;
      return (
        rankValue(challenger.tripleRank as Rank) >
        rankValue(current.tripleRank as Rank)
      );

    case "fourOfAKind":
      if (current.kind !== "fourOfAKind") return false;
      return (
        rankValue(challenger.quadRank as Rank) >
        rankValue(current.quadRank as Rank)
      );
  }
}
