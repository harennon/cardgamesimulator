# LLD 3: WebSocket Layer

Replace the deleted SSE infrastructure with Socket.IO for bidirectional real-time game communication. After this LLD, players can connect via WebSocket, authenticate, join game rooms, submit actions, and receive per-player filtered state updates.

---

## 1. Scope

### In scope
- Socket.IO server setup (attached to the existing Express HTTP server)
- Authentication middleware on socket connection (reuse Supabase JWT verification)
- Room management (join/leave by gameId; separate player and spectator rooms)
- Event protocol: client-to-server and server-to-client event types with typed payloads
- GameService orchestration layer (ties WebSocket events to GameEngine + GameCache + DB)
- PlayerView filtering per connected player (information hiding)
- Reconnection handling (rejoin room, receive current state)
- Error emission to clients (invalid actions, unauthorized, game not found)
- Frontend Socket.IO client composable (`useSocket.ts`)
- Connection status tracking on the frontend

### Out of scope
- Guest access tokens (LLD 5 — this LLD handles only Supabase JWTs)
- Turn timer and auto-pass (LLD 7)
- Spectator join-in-progress UX and disconnect grace period (LLD 8)
- Frontend game UI components (LLD 6)
- Big2 engine implementation (LLD 4)
- Lobby REST API changes beyond what is needed for "Start Game" (lobby CRUD is already functional from LLD 1)

---

## 2. Approach

### Key decisions

1. **Attach to existing HTTP server.** Socket.IO shares the same `http.Server` instance that Express uses. No separate port. The nginx reverse proxy already handles WebSocket upgrade via the `/socket.io/` path.

2. **Auth on connection only.** JWT verification happens once during the Socket.IO handshake (via `io.use()` middleware). Individual events are not re-authenticated — the socket's `data` object carries the verified `userId` and `displayName` for the lifetime of the connection. Token expiry during an active connection is acceptable for turn-based games (sessions are short). The frontend reconnects with a fresh token if the connection drops.

3. **Room naming convention.** Each game has two rooms:
   - `game:{gameId}` — players in the game (receive `PlayerView`)
   - `spectators:{gameId}` — spectators (receive `SpectatorView`)
   
   A player's socket joins the player room. A spectator's socket joins the spectator room. The server emits individually to each player socket (not to the room) because each player receives a different filtered view.

4. **Individual emit for PlayerView, room broadcast for SpectatorView.** Since each player sees different state (their own hand, their own validActions), the server iterates over connected player sockets and emits individually. Spectators all see the same SpectatorView, so a single room emit suffices.

5. **GameService as orchestration layer.** A new `GameService` class coordinates between the WebSocket layer, GameEngine, GameCache, and GameRepository. The WebSocket handler is thin — it validates the message shape, delegates to GameService, and emits results. GameService handles the cache-first read, engine call, cache update, DB persistence, and broadcast logic described in LLD 2 Section 7.2.

6. **Lobby events via WebSocket.** The "Start Game" action transitions through WebSocket (not REST) so that all players in the lobby receive the initial game state immediately. Joining a lobby still happens via REST (the player needs a game to exist first), but after joining, the player connects via WebSocket to receive real-time lobby updates (player joined/left) and the game start signal.

7. **Action spoofing prevention (server-authoritative identity).** The `game:action` handler MUST inject `socket.data.userId` (set during JWT verification at connection time) as the `playerId` field on every `GameAction` before passing it to `GameService`. The client-supplied `playerId` in the action payload is discarded. This ensures a player can never impersonate another player, consistent with Architecture Principle 1 (Server-Authoritative State): "Never trust client-submitted data beyond which option did the player choose."

---

## 3. Interfaces / Types

### 3.1 Socket Authentication Data

```typescript
// src/backend/websocket/types.ts

import type { PlayerId } from "@shared/engine-types";

/** Attached to socket.data after successful auth middleware */
export interface SocketData {
  userId: PlayerId;
  displayName: string;
}

/** Shape of the auth payload sent in the Socket.IO handshake */
export interface SocketAuthPayload {
  token: string;  // Supabase access_token (JWT)
}
```

### 3.2 Client-to-Server Events

```typescript
// src/shared/socket-events.ts

import type { GameAction, PlayerId } from "./engine-types";

/** Events the client emits to the server */
export interface ClientToServerEvents {
  /** Join a game room as a player. Emitted after WebSocket connection established. */
  "game:join": (payload: GameJoinPayload, ack: (response: GameJoinResponse) => void) => void;

  /** Leave the current game room. */
  "game:leave": (payload: GameLeavePayload) => void;

  /** Submit a game action (play cards, pass, etc.) */
  "game:action": (payload: GameActionPayload, ack: (response: GameActionResponse) => void) => void;

  /** Host starts the game from the lobby. */
  "game:start": (payload: GameStartPayload, ack: (response: GameStartResponse) => void) => void;
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
  action: GameAction;
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
```

### 3.3 Server-to-Client Events

```typescript
// src/shared/socket-events.ts (continued)

import type { PlayerView, SpectatorView, PlayerInfo } from "./engine-types";

/** Events the server emits to clients */
export interface ServerToClientEvents {
  /** Full game state update for a player (filtered to their view). */
  "game:state": (view: PlayerView) => void;

  /** Full game state update for a spectator. */
  "game:spectatorState": (view: SpectatorView) => void;

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
  "error": (payload: SocketErrorPayload) => void;
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
```

### 3.4 GameService Interface

```typescript
// src/backend/service/gameService.ts

import type {
  InternalGameState,
  GameAction,
  PlayerView,
  SpectatorView,
  PlayerId,
  PlayerInfo,
} from "@shared/engine-types";

export interface GameService {
  /**
   * Load game state (cache-first, fallback to DB).
   * Returns null if game does not exist.
   */
  getGameState(gameId: string): Promise<InternalGameState | null>;

  /**
   * Start a game: initialize the engine, cache state, persist to DB.
   * Returns the initial InternalGameState.
   * Throws if game is not in CREATED status, caller is not host, or not enough players.
   */
  startGame(gameId: string, requesterId: PlayerId): Promise<InternalGameState>;

  /**
   * Apply a game action. Returns the new state on success.
   * Throws on invalid action or game not found.
   */
  applyAction(gameId: string, action: GameAction): Promise<InternalGameState>;

  /**
   * Get the filtered view for a specific player.
   */
  getPlayerView(gameId: string, playerId: PlayerId): Promise<PlayerView | null>;

  /**
   * Get the spectator view.
   */
  getSpectatorView(gameId: string, spectatorCount: number): Promise<SpectatorView | null>;
}
```

### 3.5 Socket.IO Server Setup

```typescript
// src/backend/websocket/socketServer.ts

import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@shared/socket-events";
import type { SocketData } from "./types";

export type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export function createSocketServer(httpServer: HttpServer): TypedServer {
  const io: TypedServer = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || "http://localhost:5173",
      credentials: true,
    },
    // Optimization: transparently restore room membership and replay missed events
    // for short disconnects (< 30s). If this fails, the client falls back to
    // manual rejoin via "game:join" (see Reconnection Flow in Section 4).
    connectionStateRecovery: {
      maxDisconnectionDuration: 30_000,  // 30 seconds — window for automatic recovery
    },
  });

  return io;
}
```

### 3.6 Socket Auth Middleware

```typescript
// src/backend/websocket/socketAuth.ts

import jwt from "jsonwebtoken";
import type { TypedSocket } from "./socketServer";
import type { SupabaseJWTPayload } from "@/middleware/authMiddleware";

const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

/**
 * Socket.IO middleware that verifies the JWT from the handshake auth payload.
 * Reuses the same verification logic as the REST authMiddleware.
 */
export function socketAuthMiddleware(socket: TypedSocket, next: (err?: Error) => void): void {
  const token = socket.handshake.auth?.token;

  if (!token || typeof token !== "string") {
    return next(new Error("UNAUTHORIZED: No token provided"));
  }

  try {
    const decoded = jwt.verify(token, jwtSecret as string, {
      algorithms: ["HS256"],
    }) as unknown as SupabaseJWTPayload;

    if (decoded.role !== "authenticated") {
      return next(new Error("UNAUTHORIZED: Invalid role"));
    }

    socket.data.userId = decoded.sub;
    socket.data.displayName = decoded.user_metadata?.display_name ?? decoded.email;
    next();
  } catch {
    next(new Error("UNAUTHORIZED: Invalid token"));
  }
}
```

### 3.7 Connection Manager

```typescript
// src/backend/websocket/connectionManager.ts

import type { TypedSocket } from "./socketServer";
import type { PlayerId } from "@shared/engine-types";

/**
 * Tracks which sockets belong to which players in which games.
 * A player may have multiple sockets (multiple tabs).
 * A player is "connected" if they have at least one active socket.
 */
export class ConnectionManager {
  // gameId -> playerId -> Set<socketId>
  private readonly playerSockets: Map<string, Map<PlayerId, Set<string>>> = new Map();
  // socketId -> socket reference (for individual emit)
  private readonly sockets: Map<string, TypedSocket> = new Map();
  // gameId -> Set<socketId> (spectator sockets)
  private readonly spectatorSockets: Map<string, Set<string>> = new Map();

  /** Register a player socket for a game. */
  addPlayerSocket(gameId: string, playerId: PlayerId, socket: TypedSocket): void;

  /** Remove a socket. Returns the gameId and role if the socket was registered. */
  removeSocket(socketId: string): { gameId: string; playerId: PlayerId; role: "player" | "spectator" } | null;

  /** Register a spectator socket for a game. */
  addSpectatorSocket(gameId: string, socket: TypedSocket): void;

  /** Get all player socket instances for a game (for individual PlayerView emit). */
  getPlayerSockets(gameId: string): Array<{ playerId: PlayerId; socket: TypedSocket }>;

  /** Get the spectator room name for broadcast. */
  getSpectatorCount(gameId: string): number;

  /** Check if a player has any active connections to a game. */
  isPlayerConnected(gameId: string, playerId: PlayerId): boolean;

  /** Get all connected player IDs for a game. */
  getConnectedPlayerIds(gameId: string): PlayerId[];
}
```

### 3.8 Frontend Socket Composable

```typescript
// src/frontend/composables/useSocket.ts

import { ref, readonly, onUnmounted } from "vue";
import { io, Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@shared/socket-events";
import { getAccessToken } from "@/service/authService";

type TypedClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function useSocket() {
  const socket = ref<TypedClientSocket | null>(null);
  const connected = ref(false);
  const error = ref<string | null>(null);

  async function connect(): Promise<void> {
    // Guard: prevent orphan sockets if connect() is called multiple times
    if (socket.value) {
      // Already connected or connecting — no-op
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      error.value = "Not authenticated";
      return;
    }

    const s = io(import.meta.env.VITE_API_BASE_URL || "", {
      auth: { token },
      transports: ["websocket"],  // Skip long-polling, go straight to WebSocket
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    s.on("connect", () => { connected.value = true; error.value = null; });
    s.on("disconnect", () => { connected.value = false; });
    s.on("connect_error", (err) => { error.value = err.message; connected.value = false; });

    socket.value = s;
  }

  function disconnect(): void {
    socket.value?.disconnect();
    socket.value = null;
    connected.value = false;
  }

  onUnmounted(() => { disconnect(); });

  return {
    socket: readonly(socket),
    connected: readonly(connected),
    error: readonly(error),
    connect,
    disconnect,
  };
}
```

---

## 4. State Model

### Connection Lifecycle

```
Client                           Server
  │                                │
  │── Socket.IO connect ──────────►│
  │   (auth: { token: JWT })       │── socketAuthMiddleware verifies JWT
  │                                │── socket.data.userId = sub
  │◄── "connect" ack ─────────────│
  │                                │
  │── "game:join" { gameId } ─────►│
  │                                │── Verify player is in game.playerIds
  │                                │── connectionManager.addPlayerSocket(...)
  │                                │── socket.join("game:{gameId}")
  │                                │── Check game.status:
  │                                │     CREATED → emit lobby events (player list)
  │                                │     IN_PROGRESS → emit "game:state" (PlayerView)
  │                                │     COMPLETED → emit "game:state" (final state)
  │◄── ack { success: true } ──────│
  │◄── (state appropriate to game status)│
  │                                │
  │── "game:action" { action } ───►│
  │                                │── OVERRIDE action.playerId = socket.data.userId
  │                                │── gameService.applyAction(...)
  │                                │── broadcast new state to all players
  │◄── ack { success: true } ──────│
  │◄── "game:state" (new view) ────│
  │                                │
  │── disconnect ─────────────────►│
  │                                │── connectionManager.removeSocket(...)
  │                                │── broadcast "game:playerDisconnected" to room
```

### State Ownership

| State | Location | Lifetime |
|-------|----------|----------|
| Game state (InternalGameState) | GameCache (in-memory) + DB | Persisted to DB on every action |
| Connection registry | ConnectionManager (in-memory) | Lost on server restart (clients reconnect) |
| Socket auth data | socket.data | Per-connection lifetime |
| Room membership | Socket.IO internal rooms | Per-connection lifetime |

### Reconnection Flow

There are two reconnection paths. Socket.IO's `connectionStateRecovery` is the fast path; the manual `game:join` rejoin is the fallback.

**Path A: Automatic recovery (within 30s)**

Socket.IO's built-in `connectionStateRecovery` transparently restores room memberships and replays missed packets if the client reconnects within the `maxDisconnectionDuration` window (30 seconds). From the application's perspective:
- The socket retains its original `socket.id` and `socket.data`.
- The socket is automatically re-added to its Socket.IO rooms (no `game:join` needed).
- Missed events emitted during the disconnection are replayed by the library.
- The server detects successful recovery via `socket.recovered === true` in the `connection` handler. When recovered, skip `game:playerDisconnected`/`game:playerReconnected` broadcasts (the player was never visibly gone).
- The ConnectionManager still has the socket registered (the socket ID did not change).

**Path B: Manual rejoin (after 30s, or if recovery fails)**

If `connectionStateRecovery` fails (disconnect > 30s, server restart, or library cannot recover), the client gets a brand-new socket with a new `socket.id`. The flow is:

1. Client establishes a new Socket.IO connection with a fresh JWT.
2. Auth middleware verifies (same as initial connect).
3. `socket.recovered === false` — the connection handler knows this is a fresh socket.
4. Client emits `game:join` with the gameId they were in.
5. Server verifies they are in `game.playerIds`.
6. Server registers socket in ConnectionManager.
7. Server emits current `PlayerView` to the reconnected player.
8. Server broadcasts `game:playerReconnected` to other players.

**Client responsibility:** The client always emits `game:join` after `connect` fires. If recovery succeeded (`socket.recovered === true` on the client side, available since Socket.IO v4.6), the server acks but skips re-registration (the socket is already tracked). If recovery failed, the server does the full rejoin flow. This means the client code is the same in both cases — `game:join` is idempotent.

The server does not persist connection state. After Path B, reconnection is "rejoin the room and get current state." The client is responsible for knowing which game they were in (stored in Vue reactive state or localStorage).

---

## 5. Broadcast Logic

After every successful `applyAction`:

```typescript
async function broadcastGameState(gameId: string, state: InternalGameState): Promise<void> {
  const engine = engineFactory.getEngine(state.gameType);
  const playerSockets = connectionManager.getPlayerSockets(gameId);
  const spectatorCount = connectionManager.getSpectatorCount(gameId);

  // Send individualized PlayerView to each connected player
  for (const { playerId, socket } of playerSockets) {
    const view = engine.getPlayerView(state, playerId);
    const viewWithConnectionStatus = injectConnectionStatus(view, gameId);
    socket.emit("game:state", viewWithConnectionStatus);
  }

  // Send SpectatorView to all spectators (identical view)
  const spectatorView = engine.getSpectatorView(state, spectatorCount);
  const spectatorViewWithConnectionStatus = injectConnectionStatus(spectatorView, gameId);
  io.to(`spectators:${gameId}`).emit("game:spectatorState", spectatorViewWithConnectionStatus);
}
```

### `isConnected` Injection

The `GameEngine` is pure — it has no network awareness — so `engine.getPlayerView()` returns `PlayerPublicInfo` with `isConnected: true` as a default placeholder. The broadcast layer is responsible for post-processing the view to inject real connection status from the `ConnectionManager`.

```typescript
/**
 * Post-processes a PlayerView or SpectatorView to inject live connection
 * status for each player. Called AFTER engine.getPlayerView() / getSpectatorView().
 */
function injectConnectionStatus<T extends { players: readonly PlayerPublicInfo[] }>(
  view: T,
  gameId: string,
): T {
  const players = view.players.map((p) => ({
    ...p,
    isConnected: connectionManager.isPlayerConnected(gameId, p.playerId),
  }));
  return { ...view, players };
}
```

This separation preserves the engine's purity: the engine computes game logic, the WebSocket layer enriches the view with transport-layer metadata. The engine's `getPlayerView` contract (LLD 2) does not promise accurate `isConnected` values — that responsibility belongs here.

This enforces information hiding: each player receives only their filtered view. The full `InternalGameState` never leaves the server.

---

## 6. Edge Cases

| Edge case | Handling |
|-----------|----------|
| JWT expired during active connection | Socket stays connected (no re-verification per event). On disconnect + reconnect, client gets fresh token from Supabase SDK and reconnects. |
| Player opens multiple tabs | ConnectionManager tracks multiple sockets per player. All tabs receive state updates. Actions from any tab are accepted (same userId). |
| Player submits action while not their turn | Engine returns `{ success: false, error: "Not your turn" }`. Ack returns the error. No state change. |
| Player submits action for a game they are not in | `game:join` was never successful, or they are not in playerIds. Server emits error event. |
| Player submits action after game over | Engine returns `{ success: false }`. Ack returns error. |
| Simultaneous actions (race condition) | Resolved by synchronous cache update in Node.js event loop (LLD 2 Section 7.2). Second action sees already-updated state. If it's no longer their turn, engine rejects it. |
| Host starts game with insufficient players | `startGame` checks `playerIds.length >= minPlayers`. Returns error if not met. |
| Non-host tries to start game | `startGame` checks `playerIds[0] === requesterId` (host is always first player). Returns error if not. |
| Socket disconnects mid-action | The action either completed or didn't (it's synchronous). No partial state. Other players see disconnect notification. |
| Server restart | All connections lost. Clients auto-reconnect. On reconnect, clients `game:join` again. State is loaded from DB into cache. At most one un-persisted action is lost (acceptable per LLD 2). |
| Player joins a game in CREATED (lobby) status | `game:join` ack succeeds. Server emits `lobby:playerJoined` to the room (notifying other players in lobby). Server sends the joining player the current lobby state (player list, host info). No `game:state` is sent — the game has not started yet. |
| Player joins a game in IN_PROGRESS status (reconnect) | `game:join` ack succeeds. Server emits current `game:state` (PlayerView) to the joining player. Server broadcasts `game:playerReconnected` to others. |
| Player joins a game in COMPLETED status | `game:join` ack succeeds. Server emits `game:state` with `status: COMPLETED` so the client can display the game-over screen. |
| Game not found | `game:join` ack returns `{ success: false, error: "Game not found" }`. |
| Game is full (spectator joins as player) | Server checks `game.playerIds.length >= game.maxPlayers`. Rejects with `GAME_FULL` error. Offers spectator role instead (client can retry with `role: "spectator"`). |
| Invalid event payload (missing fields) | Server validates payload shape before processing. Ack returns `{ success: false, error: "..." }`. |
| Connection without auth token | `socketAuthMiddleware` rejects with error. Socket.IO emits `connect_error` to client. |
| Client sends action with a spoofed playerId | The `game:action` handler ALWAYS overwrites `action.playerId` with `socket.data.userId` before passing to GameService. The client-supplied `playerId` field is ignored entirely — a player can never submit actions as another player. |
| Game transitions to COMPLETED | After `applyAction` returns a state with `status: COMPLETED`, the server broadcasts a final `game:state` to all players (with `status: COMPLETED`, `winner`, and `scores` populated). This is the client's signal to render the game-over screen. ConnectionManager entries and room memberships are NOT cleaned up immediately — players remain connected to review the final state. Cleanup occurs when all players disconnect (or after an inactivity timeout, e.g., 10 minutes post-completion, the server force-disconnects remaining sockets and removes ConnectionManager entries). The GameCache evicts the game after the same inactivity timeout. |

---

## 7. Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| LLD 1: Supabase Migration | Implemented | JWT verification logic reused (`SupabaseJWTPayload` type, `SUPABASE_JWT_SECRET` env var) |
| LLD 2: Game Engine Interface | Implemented | `GameEngine`, `GameCache`, `GameEngineFactory`, all shared types exist |
| `src/backend/server.ts` | Exists | Must be modified to expose HTTP server and attach Socket.IO |
| `src/backend/middleware/authMiddleware.ts` | Exists | `SupabaseJWTPayload` type exported and reused |
| `src/shared/engine-types.ts` | Exists | All game types already defined |
| `socket.io` (npm) | Not installed | Add to dependencies |
| `socket.io-client` (npm) | Not installed | Add to dependencies |

---

## 8. File Changes

### Files to CREATE

| File | Purpose |
|------|---------|
| `src/shared/socket-events.ts` | Typed event interfaces (ClientToServer, ServerToClient, payloads) |
| `src/backend/websocket/socketServer.ts` | Socket.IO server creation and configuration |
| `src/backend/websocket/socketAuth.ts` | Socket auth middleware (JWT verification on handshake) |
| `src/backend/websocket/socketHandler.ts` | Event handlers (game:join, game:action, game:start, disconnect) |
| `src/backend/websocket/connectionManager.ts` | Tracks sockets per player per game |
| `src/backend/websocket/types.ts` | SocketData, SocketAuthPayload interfaces |
| `src/backend/service/gameService.ts` | Orchestration: engine + cache + DB + broadcast coordination |
| `src/frontend/composables/useSocket.ts` | Vue composable for Socket.IO client connection |

### Files to MODIFY

| File | Changes |
|------|---------|
| `src/backend/server.ts` | Expose `httpServer` instance; call `createSocketServer(httpServer)` and attach socket handlers; pass `io` to socket handler registration |
| `package.json` | Add `socket.io` and `socket.io-client` to dependencies |
| `src/backend/middleware/authMiddleware.ts` | Export `SupabaseJWTPayload` (already exported) and extract JWT secret access into a shared utility if needed — no, keep it simple: socket auth duplicates the `jwt.verify` call with the same secret. The secret is already module-scoped in both files via `process.env`. |

### Files to DELETE

None. (SSE files were already deleted in LLD 1 implementation.)

---

## 9. Implementation Steps

Execute in this sequence. Each step produces a buildable project.

### Step 1: Install dependencies

```bash
npm install socket.io socket.io-client
```

### Step 2: Create shared event types

Create `src/shared/socket-events.ts` with all `ClientToServerEvents`, `ServerToClientEvents`, payload interfaces, and `SocketErrorCode`.

### Step 3: Create WebSocket server infrastructure

Create:
- `src/backend/websocket/types.ts` — SocketData, SocketAuthPayload
- `src/backend/websocket/socketServer.ts` — `createSocketServer` function
- `src/backend/websocket/socketAuth.ts` — `socketAuthMiddleware` function
- `src/backend/websocket/connectionManager.ts` — `ConnectionManager` class

### Step 4: Create GameService

Create `src/backend/service/gameService.ts` implementing the orchestration logic:
- `getGameState`: cache-first read, DB fallback
- `startGame`: validate host, validate player count, call `engine.initialize()`, cache, persist
- `applyAction`: read from cache, call `engine.applyAction()`, update cache, persist

GameService takes `GameCache`, `GameEngineFactory`, and `GameRepository` as constructor dependencies (for testability).

### Step 5: Create socket event handlers

Create `src/backend/websocket/socketHandler.ts`:
- `registerSocketHandlers(io, gameService, connectionManager)` function
- Handles: `connection`, `game:join`, `game:leave`, `game:action`, `game:start`, `disconnect`
- On `game:join`: verify player is in game, add to ConnectionManager, join Socket.IO room, then check `game.status` to determine response: `CREATED` → emit lobby state; `IN_PROGRESS` / `COMPLETED` → emit current `PlayerView` via `game:state`
- On `game:action`: **inject `socket.data.userId` as `action.playerId`** (override whatever the client sent — prevents action spoofing), then delegate to GameService, broadcast to all players on success
- On `game:start`: delegate to GameService, broadcast initial state to all players
- On `disconnect`: remove from ConnectionManager, notify remaining players

### Step 6: Integrate into server.ts

Modify `src/backend/server.ts`:
- Store the `http.Server` reference before calling `listen()`
- After creating the HTTP server, call `createSocketServer(httpServer)`
- Register auth middleware: `io.use(socketAuthMiddleware)`
- Register event handlers: `registerSocketHandlers(io, gameService, connectionManager)`
- Instantiate `GameService` with existing singletons (`GameCache`, `GameEngineFactory`, `gameRepo`)

The modified `Server` class constructor becomes:

```typescript
constructor() {
  this.app = express();
  // ... existing middleware ...
  // ... existing route registration ...

  this.server = this.createServer(this.app);

  // Socket.IO setup
  this.io = createSocketServer(this.server);
  this.io.use(socketAuthMiddleware);

  const gameService = new GameService(gameCache, engineFactory, gameRepo);
  const connectionManager = new ConnectionManager();
  registerSocketHandlers(this.io, gameService, connectionManager);
}
```

### Step 7: Create frontend composable

Create `src/frontend/composables/useSocket.ts` with:
- `connect()` — creates Socket.IO client with JWT auth
- `disconnect()` — tears down connection
- Reactive `connected` and `error` refs
- Auto-disconnect on component unmount

### Step 8: Verify build

- `npm run build` — zero TypeScript errors
- Manual test: start server, connect from browser console with `io("http://localhost:3000", { auth: { token: "..." } })`
- Verify connection succeeds with valid token and is rejected with invalid token

---

## 10. Testing Strategy

### Unit Tests

| Test | Category | What it verifies |
|------|----------|------------------|
| socketAuthMiddleware accepts valid JWT | Unit | Calls `next()` with no error, sets `socket.data.userId` |
| socketAuthMiddleware rejects missing token | Unit | Calls `next(Error)` with "UNAUTHORIZED" message |
| socketAuthMiddleware rejects expired JWT | Unit | Calls `next(Error)` |
| socketAuthMiddleware rejects invalid signature | Unit | Calls `next(Error)` |
| socketAuthMiddleware rejects anon role | Unit | Calls `next(Error)` |
| ConnectionManager.addPlayerSocket registers correctly | Unit | `getPlayerSockets` returns the socket |
| ConnectionManager.removeSocket cleans up | Unit | Socket no longer in `getPlayerSockets` |
| ConnectionManager.isPlayerConnected multi-tab | Unit | Returns true with multiple sockets, false after all removed |
| ConnectionManager.getSpectatorCount | Unit | Returns correct count |
| GameService.getGameState cache hit | Unit | Returns cached state without DB call |
| GameService.getGameState cache miss | Unit | Loads from DB, caches, returns |
| GameService.applyAction valid | Unit | Returns new state, updates cache, calls saveGame |
| GameService.applyAction invalid | Unit | Returns error, cache unchanged, no DB write |
| GameService.startGame by host | Unit | Initializes engine, returns IN_PROGRESS state |
| GameService.startGame by non-host | Unit | Throws error |
| GameService.startGame insufficient players | Unit | Throws error |

Test approach for socket auth: construct a mock socket object with `handshake.auth.token` set. Sign JWTs using the known test JWT secret. No real Socket.IO server needed.

Test approach for GameService: inject mock `GameCache`, mock `GameEngineFactory` (returning a stub engine), and mock `GameRepository`. Verify interactions.

### Integration Tests

| Test | Category | What it verifies |
|------|----------|------------------|
| Client connects with valid token | Integration | Connection established, `connect` event fires |
| Client rejected with invalid token | Integration | `connect_error` fires with auth error |
| Player joins game room and receives state | Integration | `game:state` event received with correct PlayerView |
| Player submits action and all players receive update | Integration | Both connected players receive new `game:state` |
| Host starts game and all players receive initial state | Integration | `game:started` + `game:state` received by all |
| Player disconnects and others notified | Integration | `game:playerDisconnected` received |
| Player reconnects and receives current state | Integration | New connection, `game:join`, receives up-to-date state |
| Spectator joins and receives SpectatorView | Integration | `game:spectatorState` with no hand data |
| Information hiding: player A cannot see player B's hand | Security | Assert PlayerView for A contains no cards from B's hand |
| Action spoofing: client sends action with another player's ID | Security | Assert the action is executed as the authenticated user (socket.data.userId), not the spoofed playerId in the payload |
| isConnected reflects actual connection status | Integration | Assert `PlayerView.players[].isConnected` is true for connected players and false for disconnected players |
| game:join on CREATED game returns lobby state (not game:state) | Integration | Assert lobby events emitted, no `game:state` sent for a game that hasn't started |

Integration test approach: spin up a real Socket.IO server on a random port, connect real `socket.io-client` instances, use a mock or in-memory GameEngine (stub that returns predictable state). No database needed for WebSocket integration tests — mock the GameRepository.

### What NOT to test

- Socket.IO library behavior (reconnection logic, transport negotiation)
- That `io.to(room).emit()` delivers to the correct sockets (library responsibility)
- Frontend composable reactivity (Vue internal behavior)
- Supabase SDK token refresh (SDK responsibility)

---

## 11. Acceptance Criteria

Implementation is complete when:

1. `npm run build` succeeds with zero errors.
2. A Socket.IO client can connect with a valid Supabase JWT and is rejected without one.
3. A connected player can emit `game:join` and receive their `PlayerView` via `game:state`.
4. A host can emit `game:start` and all players in the lobby receive `game:started` followed by their individual `game:state`.
5. A player can emit `game:action` with a valid action and all players receive updated state.
6. Each player receives only their own `PlayerView` (information hiding verified — player A's view does not contain player B's cards).
7. Spectators receive `SpectatorView` with no hand data.
8. Disconnection triggers `game:playerDisconnected` for other players.
9. Reconnection (new connection + `game:join`) delivers current state.
10. Invalid actions return ack with `{ success: false, error: "..." }`.
11. All tests pass via `npm test`.
