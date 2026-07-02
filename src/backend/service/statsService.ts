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
   * When `practice` is true, skips ALL writes (both incrementStats and
   * recordGameHistory) for every seat. Practice games are never recorded.
   * Silently skips guest players. Errors on individual player upserts are
   * logged but do not block other players' stat recording.
   */
  async recordGameCompletion(
    state: InternalGameState,
    practice: boolean = false,
  ): Promise<void> {
    if (state.status !== "COMPLETED") return;
    if (!state.scores || state.scores.length === 0) return;

    if (practice) return;

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

      // The aggregate increment (lifetime fast path) and the history append
      // (windowed source) are two writes from the same derived values. Each is
      // caught independently so one failing does not skip the other or block
      // other players (best-effort, fire-and-forget — LLD 101 A1/E4).
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

      try {
        await this.statsRepo.recordGameHistory({
          userId: playerScore.playerId,
          gameType,
          won: gamesWon === 1,
          lost: gamesLost === 1,
          score: playerScore.score,
        });
      } catch (err: unknown) {
        console.error(
          `Failed to record game history for player ${playerScore.playerId}:`,
          err,
        );
      }
    }
  }

  private isGuest(playerId: string): boolean {
    return this.guestSessionStore.get(playerId) !== null;
  }
}
