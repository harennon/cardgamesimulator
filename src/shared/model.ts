// GAME Requests
import type { GameType, GameStatus } from "./engine-types.js";
export type { GameType, GameStatus };

// Typed, persisted game configuration. Generic across game types; fields are
// game-specific and optional. Persisted as the games.game_config JSONB column.
export interface GameConfig {
  // Tonk only: target deck length in rounds, integer [5,12], default 8.
  // Absent for Big2 and for Tonk games created before this field existed.
  deckRoundsTarget?: number;
}

export interface CreateGameRequest {
  gameType: GameType;
  maxPlayers: number;
  gameOptions: { [key: string]: string };
  turnTimerSeconds: 30 | 60 | 90;
  deckRoundsTarget?: number; // optional, integer [5,12]; omitted -> default 8
}

export interface CreateGameResponse {
  gameId: string;
  gameType: GameType;
  joinCode: string; // 4-char alphanumeric code
}

export interface ResolveJoinCodeResponse {
  gameId: string;
}

export interface JoinGameRequest {
  gameId: string;
}

export interface JoinGameResponse {
  gameId: string;
  gameType: GameType;
}

export interface GetGameStateRequest {
  gameId: string;
}

export interface GetGameStateResponse {
  gameId: string;
  gameState: SerializableGame;
}

export interface SerializableGame {
  gameId: string;
  gameType: GameType;
  maxPlayers: number;
  playerIds: string[];
  playerDisplayNames: Record<string, string>;
  status: GameStatus;
  state: SerializableGameState;
  turnTimerSeconds: number | null; // null means no timer
  joinCode: string | null; // 4-char room code; null if game has none
  gameConfig: GameConfig; // always present; {} for Big2
}

export type SerializableGameState = Record<string, unknown>;

export interface GameStatsEntry {
  gameType: GameType;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  totalScore: number;
  winRate: number; // gamesWon / gamesPlayed (0 if none), rounded to 3 dp
  lastPlayedAt: string | null; // ISO 8601
}

export interface GetStatsResponse {
  userId: string;
  games: GameStatsEntry[]; // one entry per game type the user has played; [] if none
}

export type FeedbackCategory =
  | "bug"
  | "confusing-ux"
  | "feature-request"
  | "other";

export interface SubmitFeedbackRequest {
  category: FeedbackCategory;
  description: string; // 1-500 characters, required
}

export interface SubmitFeedbackResponse {
  id: string;
  createdAt: string; // ISO 8601
}
