import type { Suit, Rank } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types";
import type { PRNG } from "../prng.js";
import { buildOrderedPool, cutAmount } from "./constants.js";

export interface DealtTrick {
  readonly hands: readonly (readonly TonkCard[])[];
  readonly stock: readonly TonkCard[];
  /** Number of cards physically in play this trick (hands + stock + any face-up start card). */
  readonly trickDeckSize: number;
}

/**
 * Build, shuffle, and cut a deck for one trick, then deal 5 to each player.
 * Deterministic given the PRNG (seed it from a per-trick sub-seed at the call site).
 *
 * - `numDecks` decks (52 + 2 jokers each) are shuffled together.
 * - The top `cutAmount` cards are removed (blind cut — may include jokers).
 * - 5 cards are dealt face down to each player.
 * - The remainder forms the face-down stock.
 *
 * `trickDeckSize` (= poolSize - cut) is the conservation invariant total for the trick.
 */
export function buildTonkDeck(
  players: number,
  numDecks: number,
  deckRoundsTarget: number,
  prng: PRNG,
): DealtTrick {
  const pool = buildOrderedPool(numDecks);
  const shuffled = prng.shuffle(pool);
  const cut = cutAmount(players, numDecks, deckRoundsTarget);
  const cutDeck = shuffled.slice(cut);

  const hands: TonkCard[][] = [];
  for (let i = 0; i < players; i++) {
    hands.push(cutDeck.slice(i * 5, i * 5 + 5));
  }
  const stock = cutDeck.slice(players * 5);

  return { hands, stock, trickDeckSize: cutDeck.length };
}

/**
 * A fresh single standard deck (52 cards + 2 jokers = 54), shuffled via the
 * provided PRNG. Used ONLY for the TRUE-LOSER joker draw (§5.3, §8.5) —
 * always one deck regardless of in-play numDecks. Joker ids are 0 and 1.
 */
export function buildTrueLoserDeck(prng: PRNG): readonly TonkCard[] {
  const SUITS: readonly Suit[] = ["clubs", "diamonds", "hearts", "spades"];
  const RANKS: readonly Rank[] = [
    "A",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
  ];
  const pool: TonkCard[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      pool.push({ suit, rank });
    }
  }
  pool.push({ joker: true, id: 0 });
  pool.push({ joker: true, id: 1 });
  return prng.shuffle(pool);
}
