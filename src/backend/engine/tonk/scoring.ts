import type { TonkCard } from "@shared/tonk-types.js";
import { isJoker } from "@shared/tonk-types.js";
import type { PRNG } from "../prng.js";
import { handValue, TONK_PENALTY, LOSE_THRESHOLD } from "./constants.js";
import { buildTrueLoserDeck } from "./deck.js";

/**
 * Compute the per-seat tally delta for a finished trick.
 *
 * Case A — TONK called and caller strictly lowest: every other player adds own
 *   hand value; caller adds 0.
 * Case B — TONK called but caller tied or beaten: caller adds 30; others 0.
 * Case C — stock exhausted, no TONK: lowest hand adds 30 (ties each add 30); others 0.
 */
export function scoreTrick(
  hands: readonly (readonly TonkCard[])[],
  tonkCallerIndex: number | null,
): readonly number[] {
  const values = hands.map((h) => handValue(h));
  const deltas = hands.map(() => 0);

  if (tonkCallerIndex !== null) {
    const callerValue = values[tonkCallerIndex]!;
    const callerStrictlyLowest = values.every(
      (v, i) => i === tonkCallerIndex || v > callerValue,
    );

    if (callerStrictlyLowest) {
      // Case A
      for (let i = 0; i < values.length; i++) {
        deltas[i] = i === tonkCallerIndex ? 0 : values[i]!;
      }
    } else {
      // Case B
      deltas[tonkCallerIndex] = TONK_PENALTY;
    }
    return deltas;
  }

  // Case C — stock-out
  const lowest = Math.min(...values);
  for (let i = 0; i < values.length; i++) {
    if (values[i] === lowest) deltas[i] = TONK_PENALTY;
  }
  return deltas;
}

export interface MatchEndResult {
  readonly lostPlayerIndices: readonly number[];
  readonly trueLoserIndex: number;
}

/**
 * Detect match end and resolve the TRUE LOSER.
 *
 * Returns null when no tally has reached 150 (match continues). Otherwise:
 * - single lost player -> that seat is the TRUE LOSER (no draw)
 * - multiple lost players -> draw from a fresh single 54-card deck in ascending
 *   seat order, looping, until a joker is drawn (termination guaranteed).
 */
export function resolveMatchEnd(
  tallies: readonly number[],
  prng: PRNG,
): MatchEndResult | null {
  const lostPlayerIndices: number[] = [];
  for (let i = 0; i < tallies.length; i++) {
    if (tallies[i]! >= LOSE_THRESHOLD) lostPlayerIndices.push(i);
  }

  if (lostPlayerIndices.length === 0) return null;

  if (lostPlayerIndices.length === 1) {
    return { lostPlayerIndices, trueLoserIndex: lostPlayerIndices[0]! };
  }

  const drawDeck = buildTrueLoserDeck(prng);
  let drawIndex = 0;
  let seatPos = 0;
  for (;;) {
    const card = drawDeck[drawIndex % drawDeck.length]!;
    const seat = lostPlayerIndices[seatPos % lostPlayerIndices.length]!;
    if (isJoker(card)) {
      return { lostPlayerIndices, trueLoserIndex: seat };
    }
    drawIndex++;
    seatPos++;
  }
}
