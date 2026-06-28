import type { TonkCard } from "@shared/tonk-types.js";

/** TONK gate: open iff every player has had at least one full turn. */
export function isTonkGateOpen(
  trickTurnCount: number,
  playerCount: number,
): boolean {
  return trickTurnCount >= playerCount;
}

/** Next seat in ascending (wrapping) order. */
export function nextSeat(currentIndex: number, playerCount: number): number {
  return (currentIndex + 1) % playerCount;
}

/**
 * The snapshot the NEW current player may draw from the discard, captured at
 * turn hand-off BEFORE they discard: the single top-most card the immediately-
 * preceding active player placed (or null if they placed nothing).
 *
 * `discardPile` here is the pile as it stands after the preceding player's turn
 * (before the new current player discards). `lastDiscardCount` is how many the
 * preceding player placed; only the single top 1 is drawable.
 */
export function computeDrawableSnapshot(
  discardPile: readonly TonkCard[],
  lastDiscardCount: number,
): TonkCard | null {
  if (discardPile.length === 0 || lastDiscardCount <= 0) return null;
  return discardPile[discardPile.length - 1] ?? null;
}

/**
 * Next-trick starter / dealer: the player with the highest overall tally.
 * Ties broken by lowest seat index (§3.1.5, §8.7).
 */
export function nextStarterIndex(tallies: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < tallies.length; i++) {
    if (tallies[i]! > tallies[best]!) best = i;
  }
  return best;
}
