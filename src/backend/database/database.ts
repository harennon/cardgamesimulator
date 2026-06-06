import { Game } from "@/database/entities/Game";
import { PlayerStats } from "@/database/entities/PlayerStats";
import type { GameType } from "@shared/engine-types";

export interface GameRepository {
  createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
  ): Promise<Game>;
  getGame(gameId: string): Promise<Game | null>;
  saveGame(game: Game): Promise<Game>; // throws OptimisticLockVersionMismatchError on version conflict
}
// Note: `createGame` takes gameId as a parameter (caller generates UUID via `crypto.randomUUID()`).
// This allows the REST handler to generate the ID and use it for in-memory cache registration (LLD 2) in the same call.

export interface PlayerStatsRepository {
  getStats(userId: string): Promise<PlayerStats | null>;
  upsertStats(stats: PlayerStats): Promise<PlayerStats>;
}
