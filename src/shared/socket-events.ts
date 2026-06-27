import type {
  GameAction,
  PlayerView,
  SpectatorView,
  PlayerInfo,
} from "./engine-types.js";

/** Events the client emits to the server */
export interface ClientToServerEvents {
  /** Join a game room as a player or spectator. Emitted after WebSocket connection established. */
  "game:join": (
    payload: GameJoinPayload,
    ack: (response: GameJoinResponse) => void,
  ) => void;

  /** Leave the current game room. */
  "game:leave": (payload: GameLeavePayload) => void;

  /** Submit a game action (play cards, pass, etc.) */
  "game:action": (
    payload: GameActionPayload,
    ack: (response: GameActionResponse) => void,
  ) => void;

  /** Host starts the game from the lobby. */
  "game:start": (
    payload: GameStartPayload,
    ack: (response: GameStartResponse) => void,
  ) => void;
}

export interface GameJoinPayload {
  gameId: string;
  role: "player" | "spectator";
}

export interface GameJoinResponse {
  success: boolean;
  error?: string;
}

export interface GameLeavePayload {
  gameId: string;
}

export interface GameActionPayload {
  gameId: string;
  // GameAction is the base type. Game-specific actions (e.g. Big2PlayCardsAction)
  // extend it with additional fields (e.g. `cards`). Using an intersection with
  // Record<string, unknown> allows those extra fields while preserving the base
  // type constraint that the server needs for safe playerId override.
  action: GameAction & Record<string, unknown>;
}

export interface GameActionResponse {
  success: boolean;
  error?: string;
}

export interface GameStartPayload {
  gameId: string;
}

export interface GameStartResponse {
  success: boolean;
  error?: string;
}

/** PlayerView enriched with timer deadline + room code for WebSocket emission. */
export interface EnrichedPlayerView extends PlayerView {
  readonly turnDeadline: number | null; // epoch ms, or null if no timer
  readonly joinCode: string | null; // 4-char room code; null if game has none
}

/** SpectatorView enriched with timer deadline for WebSocket emission. */
export interface EnrichedSpectatorView extends SpectatorView {
  readonly turnDeadline: number | null;
}

export interface TimerExpiredPayload {
  gameId: string;
  playerId: string; // the player whose turn was auto-acted
  action: "pass" | "playCards"; // what was auto-played
}

export interface SpectatorCountPayload {
  gameId: string;
  count: number;
}

/** Events the server emits to clients */
export interface ServerToClientEvents {
  /** Full game state update for a player (filtered to their view). */
  "game:state": (view: EnrichedPlayerView) => void;

  /** Full game state update for a spectator. */
  "game:spectatorState": (view: EnrichedSpectatorView) => void;

  /** Emitted when the turn timer expires and an auto-action was applied. */
  "game:timerExpired": (payload: TimerExpiredPayload) => void;

  /** Spectator count changed (emitted to players when a spectator joins/leaves). */
  "game:spectatorCount": (payload: SpectatorCountPayload) => void;

  /** Full lobby state sent to a player upon joining a CREATED game room. */
  "lobby:state": (payload: LobbyStatePayload) => void;

  /** A player joined the lobby (pre-game). */
  "lobby:playerJoined": (payload: LobbyPlayerJoinedPayload) => void;

  /** A player left the lobby (pre-game). */
  "lobby:playerLeft": (payload: LobbyPlayerLeftPayload) => void;

  /** The game has started (lobby-to-game transition). Clients receive their first game:state immediately after. */
  "game:started": () => void;

  /** A player disconnected mid-game. */
  "game:playerDisconnected": (payload: PlayerDisconnectedPayload) => void;

  /** A player reconnected mid-game. */
  "game:playerReconnected": (payload: PlayerReconnectedPayload) => void;

  /** Server-side error for this client. */
  error: (payload: SocketErrorPayload) => void;
}

export interface LobbyStatePayload {
  players: PlayerInfo[];
  maxPlayers: number;
  joinCode: string; // 4-char invite code
}

export interface LobbyPlayerJoinedPayload {
  player: PlayerInfo;
  playerCount: number;
}

export interface LobbyPlayerLeftPayload {
  playerId: string;
  playerCount: number;
}

export interface PlayerDisconnectedPayload {
  playerId: string;
  displayName: string;
}

export interface PlayerReconnectedPayload {
  playerId: string;
  displayName: string;
}

export interface SocketErrorPayload {
  code: SocketErrorCode;
  message: string;
}

export type SocketErrorCode =
  | "UNAUTHORIZED"
  | "GAME_NOT_FOUND"
  | "GAME_FULL"
  | "NOT_IN_GAME"
  | "NOT_YOUR_TURN"
  | "INVALID_ACTION"
  | "GAME_NOT_STARTED"
  | "GAME_ALREADY_STARTED"
  | "NOT_HOST"
  | "NOT_ENOUGH_PLAYERS"
  | "INTERNAL_ERROR";
