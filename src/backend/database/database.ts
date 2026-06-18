import { Game } from "@/database/entities/Game";
import { PlayerStats } from "@/database/entities/PlayerStats";
import { Feedback } from "@/database/entities/Feedback";
import type { GameType } from "@shared/engine-types";

export interface GameRepository {
  createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
    turnTimerSeconds: number | null,
  ): Promise<Game>;
  getGame(gameId: string): Promise<Game | null>;
  saveGame(game: Game): Promise<Game>; // throws OptimisticLockError on version conflict
}
// Note: `createGame` takes gameId as a parameter (caller generates UUID via `crypto.randomUUID()`).
// This allows the REST handler to generate the ID and use it for in-memory cache registration (LLD 2) in the same call.

export interface StatsDelta {
  gamesPlayed: number; // always 1
  gamesWon: number; // 1 or 0
  gamesLost: number; // 1 or 0
  totalScore: number; // placement score from the game
}

export interface PlayerStatsRepository {
  getStats(userId: string): Promise<PlayerStats | null>;
  /**
   * Atomically increment stats for a player. Creates the row if it doesn't exist.
   * Uses SQL ON CONFLICT DO UPDATE to avoid read-modify-write races.
   */
  incrementStats(userId: string, delta: StatsDelta): Promise<void>;
}

export interface FeedbackRepository {
  createFeedback(feedback: Feedback): Promise<Feedback>;
  getAllFeedback(): Promise<Feedback[]>;
}

export interface JoinCodeRepository {
  createJoinCode(code: string, gameId: string): Promise<void>;
  getGameIdByCode(code: string): Promise<string | null>;
  deleteByGameId(gameId: string): Promise<void>;
  deleteExpired(maxAgeMs: number): Promise<number>; // returns count deleted
}
