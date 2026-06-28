import type { Card } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types.js";
import type { PRNG } from "../prng.js";
import { FULL_DECK } from "../big2/constants.js";
import {
  JOKERS_PER_DECK,
  HAND_SIZE,
  MIN_DECK_ROUNDS_TARGET,
  MAX_DECK_ROUNDS_TARGET,
  DEFAULT_DECK_ROUNDS_TARGET,
} from "./constants.js";

/** numDecks = ceil(players / 5). 3-5 -> 1, 6-10 -> 2. */
export function deckCount(playerCount: number): number {
  return Math.ceil(playerCount / 5);
}

/**
 * Clamp and default deckRoundsTarget to an integer in [5, 12], default 8.
 * Defensive — authoritative validation is createGame.ts (#60).
 */
export function resolveDeckRoundsTarget(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_DECK_ROUNDS_TARGET;
  }
  const rounded = Math.round(raw);
  return Math.min(
    MAX_DECK_ROUNDS_TARGET,
    Math.max(MIN_DECK_ROUNDS_TARGET, rounded),
  );
}

/** clamp(x, [lo, hi]) = min(hi, max(lo, x)). */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * The §8.1 unified cut formula. Returns how many cards are blindly removed
 * from the shuffled pool.
 */
export function cutAmount(
  playerCount: number,
  numDecks: number,
  deckRoundsTarget: number,
): number {
  const handCardsDealt = HAND_SIZE * playerCount;
  const poolSize = 54 * numDecks;
  const targetCards = handCardsDealt + deckRoundsTarget * playerCount;
  const clamped = clamp(targetCards, handCardsDealt + playerCount, poolSize);
  return Math.max(0, poolSize - clamped);
}

/**
 * Recover a deckRoundsTarget in [5, 12] whose cut reproduces the given
 * post-cut deck size, so subsequent tricks rebuild with the same cut without
 * storing the target separately. Returns the lowest matching target (cutAmount
 * is monotonic in target, so any match yields the identical cut). Falls back to
 * the default when nothing matches (defensive — should not happen for in-range
 * targets the engine itself produced).
 */
export function recoverDeckRoundsTarget(
  playerCount: number,
  numDecks: number,
  deckSize: number,
): number {
  const poolSize = 54 * numDecks;
  for (
    let target = MIN_DECK_ROUNDS_TARGET;
    target <= MAX_DECK_ROUNDS_TARGET;
    target++
  ) {
    if (poolSize - cutAmount(playerCount, numDecks, target) === deckSize) {
      return target;
    }
  }
  return DEFAULT_DECK_ROUNDS_TARGET;
}

/** An unshuffled pool of `numDecks` standard decks, each 52 cards + 2 jokers. */
export function buildPool(numDecks: number): TonkCard[] {
  const pool: TonkCard[] = [];
  let jokerId = 0;
  for (let d = 0; d < numDecks; d++) {
    for (const card of FULL_DECK) {
      pool.push(card);
    }
    for (let j = 0; j < JOKERS_PER_DECK; j++) {
      pool.push({ joker: true, id: jokerId++ });
    }
  }
  return pool;
}

export interface TrickDeck {
  /** Hands dealt 5 each, by seat index. */
  readonly hands: readonly (readonly TonkCard[])[];
  /** Remaining cards form the face-down stock (top = index 0 draw order). */
  readonly stock: readonly TonkCard[];
  /** Total card count of this trick's pool after the cut (deal + stock). */
  readonly deckSize: number;
}

/**
 * Build, shuffle, and cut a trick's deck, then deal 5 to each player.
 * Deterministic given the supplied PRNG (which is seeded from a per-trick sub-seed).
 */
export function buildTrickDeck(
  playerCount: number,
  numDecks: number,
  deckRoundsTarget: number,
  prng: PRNG,
): TrickDeck {
  const pool = buildPool(numDecks);
  const shuffled = prng.shuffle(pool);

  const toCut = cutAmount(playerCount, numDecks, deckRoundsTarget);
  const cutDeck = shuffled.slice(toCut);

  const hands: TonkCard[][] = [];
  for (let i = 0; i < playerCount; i++) {
    hands.push(cutDeck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE));
  }

  const stock = cutDeck.slice(playerCount * HAND_SIZE);

  return { hands, stock, deckSize: cutDeck.length };
}

/**
 * A fresh single 54-card deck (52 + 2 jokers), shuffled, for the TRUE-LOSER
 * draw — ALWAYS one deck regardless of in-play numDecks (LLD 65 §5.3, §8.5).
 */
export function buildTrueLoserDeck(prng: PRNG): TonkCard[] {
  return prng.shuffle(buildPool(1));
}

export type { Card };
