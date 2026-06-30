import { Game } from "@/database/entities/Game";
import { PlayerStats } from "@/database/entities/PlayerStats";
import { Feedback } from "@/database/entities/Feedback";
import type { GameType } from "@shared/engine-types";
import type { GameConfig } from "@shared/model";

export interface GameRepository {
  createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
    turnTimerSeconds: number | null,
    joinCode: string | null,
    gameConfig: GameConfig,
  ): Promise<Game>;
  getGame(gameId: string): Promise<Game | null>;
  getGameByJoinCode(code: string): Promise<Game | null>;
  saveGame(game: Game): Promise<Game>; // throws OptimisticLockError on version conflict
  /** Clear the join code on a game row so the code can be transferred to another
   *  game. Persists join_code = NULL. Used by the rematch flow before inserting
   *  the new game with the freed code. Does not participate in optimistic locking. */
  clearJoinCode(gameId: string): Promise<void>;
}
// Note: `createGame` takes gameId as a parameter (caller generates UUID via `crypto.randomUUID()`).
// This allows the REST handler to generate the ID and use it for in-memory cache registration (LLD 2) in the same call.

export interface StatsDelta {
  gamesPlayed: number; // always 1
  gamesWon: number; // 1 or 0
  gamesLost: number; // 1 or 0
  totalScore: number; // placement score from the game
}

export interface GameHistoryRow {
  userId: string;
  gameType: GameType;
  won: boolean;
  lost: boolean;
  score: number;
}

export interface PlayerStatsRepository {
  /** Stats for one user in one game type, or null if they've never played it. */
  getStats(userId: string, gameType: GameType): Promise<PlayerStats | null>;

  /** All per-game-type stat rows for a user (one entry per game type played; may be empty). */
  getAllStats(userId: string): Promise<PlayerStats[]>;

  /**
   * Atomically increment stats for (userId, gameType). Creates the row if absent.
   * Uses SQL ON CONFLICT (user_id, game_type) DO UPDATE to avoid read-modify-write races.
   */
  incrementStats(
    userId: string,
    gameType: GameType,
    delta: StatsDelta,
  ): Promise<void>;

  /** Append one completed-game row. Plain INSERT (append-only, atomic). */
  recordGameHistory(row: GameHistoryRow): Promise<void>;

  /**
   * Aggregate game_history for a user since `since`, grouped by game_type.
   * Returns the same per-game-type shape getAllStats does (counts + lastPlayedAt).
   */
  getWindowedStats(userId: string, since: Date): Promise<PlayerStats[]>;

  /** Earliest played_at across all of the user's history rows, or null. */
  getTrackingSince(userId: string): Promise<Date | null>;
}

export interface FeedbackRepository {
  createFeedback(feedback: Feedback): Promise<Feedback>;
  getAllFeedback(): Promise<Feedback[]>;
  deleteFeedback(id: string): Promise<boolean>;
}
