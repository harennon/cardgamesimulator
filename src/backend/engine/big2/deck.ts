import type { Card } from "@shared/engine-types";
import type { PRNG } from "../prng.js";
import { FULL_DECK, compareCards } from "./constants.js";

/**
 * Build and shuffle the deck for the given player count.
 * Returns the dealt hands and the lowest card (used to determine who goes first).
 */
export function buildDeck(
  playerCount: number,
  prng: PRNG,
): { hands: readonly (readonly Card[])[]; lowestCard: Card } {
  let deckToShuffle: readonly Card[];

  if (playerCount === 3) {
    // Remove 3 of clubs for 3-player game
    deckToShuffle = FULL_DECK.filter(
      (c) => !(c.rank === "3" && c.suit === "clubs"),
    );
  } else {
    deckToShuffle = FULL_DECK;
  }

  const shuffled = prng.shuffle(deckToShuffle);

  let hands: Card[][];
  if (playerCount === 2) {
    // Deal 13 cards each; remaining 26 set aside
    hands = [shuffled.slice(0, 13), shuffled.slice(13, 26)];
  } else if (playerCount === 3) {
    // 51 cards, 17 each
    hands = [
      shuffled.slice(0, 17),
      shuffled.slice(17, 34),
      shuffled.slice(34, 51),
    ];
  } else {
    // 4 players, 13 cards each
    hands = [
      shuffled.slice(0, 13),
      shuffled.slice(13, 26),
      shuffled.slice(26, 39),
      shuffled.slice(39, 52),
    ];
  }

  // Find the lowest card among dealt cards
  const allDealtCards = hands.flat();
  const lowestCard = allDealtCards.reduce((lowest, card) =>
    compareCards(card, lowest) < 0 ? card : lowest,
  );

  // Sort each hand for UX (deterministic: by rank then suit)
  const sortedHands = hands.map((hand) => [...hand].sort(compareCards));

  return { hands: sortedHands, lowestCard };
}
