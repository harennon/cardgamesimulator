import type { InternalGameState } from "@shared/engine-types";
import type { PlayerStatsRepository, StatsDelta } from "@/database/database";
import type { GuestSessionStore } from "@/guest/guestSessionStore";

export class StatsService {
  constructor(
    private readonly statsRepo: PlayerStatsRepository,
    private readonly guestSessionStore: GuestSessionStore,
  ) {}

  /**
   * Record stats for all registered (non-guest) players in a completed game.
   * Called once when game status transitions to COMPLETED.
   *
   * Silently skips guest players. Errors on individual player upserts are
   * logged but do not block other players' stat recording.
   */
  async recordGameCompletion(state: InternalGameState): Promise<void> {
    if (state.status !== "COMPLETED") return;
    if (!state.scores || state.scores.length === 0) return;

    const gameType = state.gameType; // already on InternalGameState — no new dependency
    const winnerId = state.winner;

    for (const playerScore of state.scores) {
      if (this.isGuest(playerScore.playerId)) continue;

      const breakdown = playerScore.breakdown;
      const isLossCentric =
        breakdown !== undefined && breakdown.trueLoser !== undefined;

      let gamesWon: number;
      let gamesLost: number;
      if (isLossCentric) {
        gamesLost = breakdown.trueLoser === 1 ? 1 : 0;
        gamesWon = 1 - gamesLost;
      } else {
        gamesWon = playerScore.playerId === winnerId ? 1 : 0;
        gamesLost = playerScore.playerId !== winnerId ? 1 : 0;
      }

      const delta: StatsDelta = {
        gamesPlayed: 1,
        gamesWon,
        gamesLost,
        totalScore: playerScore.score,
      };

      try {
        await this.statsRepo.incrementStats(
          playerScore.playerId,
          gameType,
          delta,
        );
      } catch (err: unknown) {
        console.error(
          `Failed to record stats for player ${playerScore.playerId}:`,
          err,
        );
      }
    }
  }

  private isGuest(playerId: string): boolean {
    return this.guestSessionStore.get(playerId) !== null;
  }
}
