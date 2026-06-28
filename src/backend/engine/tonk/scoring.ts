import type { PlayerInfo, PlayerScore } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";
import type { PRNG } from "../prng.js";
import { handValue } from "./constants.js";
import { buildTrueLoserDeck } from "./deck.js";

export const TONK_LOSS_THRESHOLD = 150;
const TONK_PENALTY = 30;

/**
 * Score one trick. Returns the per-seat tally delta for this trick.
 *
 * Case A — TONK called and caller strictly lowest: every other player adds
 *   their own hand value; caller adds 0.
 * Case B — TONK called but caller tied or beaten: caller adds 30; others 0.
 * Case C — stock exhausted, no TONK: lowest hand adds 30; ties for lowest each
 *   add 30; others 0.
 */
export function scoreTrick(
  hands: readonly (readonly TonkCard[])[],
  tonkCallerIndex: number | null,
): number[] {
  const handValues = hands.map((h) => handValue(h));
  const deltas = hands.map(() => 0);

  if (tonkCallerIndex !== null) {
    const callerValue = handValues[tonkCallerIndex] as number;
    const callerStrictlyLowest = handValues.every(
      (v, i) => i === tonkCallerIndex || callerValue < v,
    );
    if (callerStrictlyLowest) {
      // Case A
      for (let i = 0; i < hands.length; i++) {
        if (i !== tonkCallerIndex) {
          deltas[i] = handValues[i] as number;
        }
      }
    } else {
      // Case B
      deltas[tonkCallerIndex] = TONK_PENALTY;
    }
    return deltas;
  }

  // Case C — stock-out, no TONK
  const lowest = Math.min(...handValues);
  for (let i = 0; i < hands.length; i++) {
    if (handValues[i] === lowest) {
      deltas[i] = TONK_PENALTY;
    }
  }
  return deltas;
}

export interface MatchEndResolution {
  readonly lostPlayerIndices: readonly number[];
  readonly trueLoserIndex: number;
  readonly winnerIndex: number; // lowest tally, ties → lowest seat index (display only)
}

/**
 * Resolve match end given final tallies. Caller guarantees at least one tally
 * is >= TONK_LOSS_THRESHOLD. Uses `prng` (seeded from a deterministic sub-seed)
 * for the TRUE-LOSER joker draw when more than one player has lost.
 */
export function resolveMatchEnd(
  tallies: readonly number[],
  prng: PRNG,
): MatchEndResolution {
  const lostPlayerIndices: number[] = [];
  for (let i = 0; i < tallies.length; i++) {
    if ((tallies[i] as number) >= TONK_LOSS_THRESHOLD) {
      lostPlayerIndices.push(i);
    }
  }

  let trueLoserIndex: number;
  if (lostPlayerIndices.length === 1) {
    trueLoserIndex = lostPlayerIndices[0] as number;
  } else {
    trueLoserIndex = drawTrueLoser(lostPlayerIndices, prng);
  }

  // Display winner: lowest tally, ties → lowest seat index.
  let winnerIndex = 0;
  for (let i = 1; i < tallies.length; i++) {
    if ((tallies[i] as number) < (tallies[winnerIndex] as number)) {
      winnerIndex = i;
    }
  }

  return { lostPlayerIndices, trueLoserIndex, winnerIndex };
}

/**
 * TRUE-LOSER draw (§5.3, §8.5): lost players draw one card at a time in
 * ascending seat order, looping, from a single fresh 54-card deck until a
 * joker is drawn. The drawer of the joker is the TRUE LOSER. Termination is
 * guaranteed by the 2 jokers in 54.
 */
function drawTrueLoser(
  lostPlayerIndices: readonly number[],
  prng: PRNG,
): number {
  const deck = buildTrueLoserDeck(prng);
  let drawIndex = 0;
  let turn = 0;
  // Bounded loop: at most 54 draws are needed before a joker appears.
  while (drawIndex < deck.length) {
    const card = deck[drawIndex] as TonkCard;
    const seat = lostPlayerIndices[turn % lostPlayerIndices.length] as number;
    if (isJoker(card)) {
      return seat;
    }
    drawIndex++;
    turn++;
  }
  // Unreachable: a joker is always drawn within 54 cards. Fall back defensively.
  return lostPlayerIndices[0] as number;
}

/**
 * Build the final per-player scores at COMPLETED. `score` = final tally
 * (lower is better). `breakdown` carries numeric flags:
 *   - trueLoser: 1 on exactly the TRUE LOSER, 0 otherwise (drives stats §6.3).
 *   - lost: 1 if finalTally >= 150 (informational), else 0.
 *   - finalTally: the running tally.
 */
export function finalScores(
  players: readonly PlayerInfo[],
  tallies: readonly number[],
  trueLoserIndex: number,
): readonly PlayerScore[] {
  return players.map((player, i) => {
    const finalTally = tallies[i] as number;
    return {
      playerId: player.playerId,
      score: finalTally,
      breakdown: {
        lost: finalTally >= TONK_LOSS_THRESHOLD ? 1 : 0,
        trueLoser: i === trueLoserIndex ? 1 : 0,
        finalTally,
      },
    };
  });
}
