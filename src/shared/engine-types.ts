// Standard playing card suits
export type Suit = "clubs" | "diamonds" | "hearts" | "spades";

// Standard playing card ranks (Big2-compatible: 3 lowest, 2 highest)
export type Rank =
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A"
  | "2";

// A single playing card — immutable value object
export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
}

// One-directional status progression. No backwards transitions.
export type GameStatus = "CREATED" | "IN_PROGRESS" | "COMPLETED";

export type GameType = "big2" | "tonk";

// Unique identifier for a player within a game session.
// Maps to either a Supabase user ID or a guest session ID.
export type PlayerId = string;

export interface PlayerInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
}

// Base type for all game actions. Each game engine defines its own
// action types that extend this with game-specific payloads.
export interface GameAction {
  readonly type: string;
  readonly playerId: PlayerId;
}

// The subset of actions a player can currently perform.
// Sent to the client as part of PlayerView.
export interface ValidAction {
  readonly type: string;
  readonly description?: string;
}

// Result of attempting to apply an action to game state.
// newState is non-null if and only if success is true.
export interface ActionResult {
  readonly success: boolean;
  readonly newState: InternalGameState | null;
  readonly error?: string;
}

// Full server-side game state. Never sent to clients directly.
export interface InternalGameState {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly status: GameStatus;
  readonly version: number;
  readonly players: readonly PlayerInfo[];
  readonly currentPlayerIndex: number;
  readonly turnNumber: number;
  readonly gameSpecificState: unknown;
  readonly winner: PlayerId | null;
  readonly scores: readonly PlayerScore[] | null;
  readonly randomSeed: string;
}

export interface PlayerScore {
  readonly playerId: PlayerId;
  readonly score: number;
  readonly breakdown?: Record<string, number>;
}

// What every player can see about every other player
export interface PlayerPublicInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly cardCount: number;
  readonly isConnected: boolean;
}

// What you can see about yourself (includes your hand)
export interface PlayerPrivateInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly hand: readonly Card[];
}

// Filtered state sent to a specific player. Physically excludes hidden information.
export interface PlayerView {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly status: GameStatus;
  readonly version: number;
  readonly players: readonly PlayerPublicInfo[];
  readonly you: PlayerPrivateInfo;
  readonly currentPlayerIndex: number;
  readonly turnNumber: number;
  readonly validActions: readonly ValidAction[];
  readonly gameSpecificPublicState: unknown;
  readonly winner: PlayerId | null;
  readonly scores: readonly PlayerScore[] | null;
}

// Filtered state for spectators. Shows public information only — no hands.
export interface SpectatorView {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly status: GameStatus;
  readonly version: number;
  readonly players: readonly PlayerPublicInfo[];
  readonly currentPlayerIndex: number;
  readonly turnNumber: number;
  readonly gameSpecificPublicState: unknown;
  readonly winner: PlayerId | null;
  readonly scores: readonly PlayerScore[] | null;
  readonly spectatorCount: number;
}
