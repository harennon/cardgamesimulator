import type { PlayerInfo, PlayerScore } from "@shared/engine-types";
import { PLACEMENT_POINTS } from "./constants.js";

/**
 * Compute placement-based scores when the game completes.
 * finishedPlayerIndices contains player indices in finishing order (1st, 2nd, ..., last).
 */
export function computeScores(
  players: readonly PlayerInfo[],
  finishedPlayerIndices: readonly number[],
): readonly PlayerScore[] {
  const points = PLACEMENT_POINTS[players.length];
  if (!points) {
    throw new Error(`No scoring table for ${players.length} players`);
  }

  return finishedPlayerIndices.map((playerIndex, placementIndex) => {
    const player = players[playerIndex] as PlayerInfo;
    const score = (points[placementIndex] ?? 0) as number;
    return {
      playerId: player.playerId,
      score,
      breakdown: { placement: placementIndex + 1 },
    };
  });
}
