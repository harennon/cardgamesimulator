export interface EchoRequest {
  string: string;
}

export interface EchoResponse {
  string: string;
}

// GAME Requests
import type { GameType, GameStatus } from "./engine-types.js";
export type { GameType, GameStatus };

export interface CreateGameRequest {
  gameType: GameType;
  maxPlayers: number;
  gameOptions: { [key: string]: string };
  turnTimerSeconds: 30 | 60 | 90;
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
}

export type SerializableGameState = Record<string, unknown>;

export interface GetStatsResponse {
  userId: string;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  totalScore: number;
  winRate: number; // computed: gamesWon / gamesPlayed (0 if no games)
  lastPlayedAt: string | null; // ISO 8601 timestamp, null if never played
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
