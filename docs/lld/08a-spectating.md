# LLD 8a: Spectating

Non-player viewing of in-progress games. Spectators join a game room, receive a filtered `SpectatorView` (no hands, public information only), and see real-time updates as players make moves.

---

## 1. Scope

### In scope

- Spectator join flow: `game:join` with `role: "spectator"` connects to spectator room, receives initial `SpectatorView`
- Spectator receives `game:spectatorState` on every game state change (action, timer expiry)
- Spectator count broadcast to players: `spectatorCount` field already included in player broadcasts via the `broadcastGameState` path
- Dedicated `game:spectatorCount` event emitted to players when spectators join/leave (lightweight notification without full state rebuild)
- Spectator action rejection: spectator sockets cannot emit `game:action` or `game:start`
- Spectator receives `turnDeadline` enrichment (consistent with players)
- Spectator sees game completion (scores, winner) when game ends
- Spectator auto-assignment: when a non-player user sends `game:join` with `role: "player"` to an IN_PROGRESS game, the server rejects it (existing behavior) -- the client is expected to offer spectator mode
- Spectator disconnect: socket removed from spectator room, count updated, no grace period
- Multiple spectators supported (no cap)
- Spectators can join COMPLETED games (see final state)

### Out of scope

- Frontend spectator UI component (renders from `game:spectatorState` -- frontend work)
- Spectator chat / reactions
- Reconnection grace periods (LLD 8b)
- Spectator-to-player promotion (not applicable -- game already started)
- Password-protected or private game spectator restrictions
- Spectator joining a CREATED game lobby (spectating only makes sense for IN_PROGRESS or COMPLETED)

---

## 2. Approach

### Key technical decisions

1. **Most infrastructure already exists.** The `ConnectionManager` has `addSpectatorSocket`, `getSpectatorCount`, and spectator reverse-lookup. The `socketHandler` already handles `role: "spectator"` in `handleGameJoin`, joins the `spectators:${gameId}` room, and broadcasts `game:spectatorState` in `broadcastGameState`. The `SpectatorView` type and `getSpectatorView` engine method are implemented. This LLD formalizes existing behavior, fills gaps, and adds the spectator count notification to players.

2. **Spectator count event for players (new).** Currently, players only learn the spectator count when they receive a full `game:state` broadcast (which includes `spectatorCount` indirectly via the spectator view -- but players get `PlayerView`, not `SpectatorView`). We add a lightweight `game:spectatorCount` event emitted to the player room (`game:${gameId}`) whenever a spectator joins or leaves. This avoids re-broadcasting full game state just because a spectator connected.

3. **Action rejection is implicit, not explicit middleware.** The `handleGameAction` already overrides `playerId` with the authenticated `socket.data.userId`. If that userId is not a player in the game, `applyAction` will reject it ("Not your turn" or similar). However, for clarity and security defense-in-depth, we add an explicit early-return in `handleGameAction` and `handleGameStart` that checks if the socket is registered as a player (not spectator) for the given game. This provides a clear error message and avoids unnecessary engine/DB calls.

4. **No spectator cap.** Spectators are cheap -- they share a single Socket.IO room broadcast. A single `io.to('spectators:${gameId}').emit(...)` handles all spectators regardless of count.

5. **Spectators can join at any game status except CREATED.** Spectating a lobby (CREATED) has no value -- there is nothing to watch. If a spectator tries to join a CREATED game, the join is rejected with a clear message. IN_PROGRESS and COMPLETED games allow spectators.

6. **`game:timerExpired` also broadcast to spectators.** Currently `game:timerExpired` is only emitted to `game:${gameId}` (player room). Since spectators are in `spectators:${gameId}`, they miss this event. We extend the broadcast to include the spectator room.

---

## 3. Interfaces / Types

### New socket event: `game:spectatorCount`

```typescript
// Addition to src/shared/socket-events.ts — ServerToClientEvents

/** Spectator count changed (emitted to players when a spectator joins/leaves). */
"game:spectatorCount": (payload: SpectatorCountPayload) => void;
```

```typescript
// New payload type
export interface SpectatorCountPayload {
  gameId: string;
  count: number;
}
```

### Updated ServerToClientEvents (complete)

```typescript
export interface ServerToClientEvents {
  "game:state": (view: EnrichedPlayerView) => void;
  "game:spectatorState": (view: EnrichedSpectatorView) => void;
  "game:timerExpired": (payload: TimerExpiredPayload) => void;
  "game:spectatorCount": (payload: SpectatorCountPayload) => void; // NEW
  "lobby:playerJoined": (payload: LobbyPlayerJoinedPayload) => void;
  "lobby:playerLeft": (payload: LobbyPlayerLeftPayload) => void;
  "game:started": () => void;
  "game:playerDisconnected": (payload: PlayerDisconnectedPayload) => void;
  "game:playerReconnected": (payload: PlayerReconnectedPayload) => void;
  error: (payload: SocketErrorPayload) => void;
}
```

### Error strings in ack responses

Spectator-specific errors are plain string literals in `ack({ success: false, error: "..." })` responses, consistent with the existing pattern (e.g., `handleGameAction` returns engine error strings in acks). They are NOT added to `SocketErrorCode` (which is used only for the `error` server-push event, not ack payloads).

- `"SPECTATOR_CANNOT_ACT"` — spectator attempted `game:action` or `game:start`
- `"SPECTATING_NOT_AVAILABLE"` — tried to spectate a game in CREATED status

### ConnectionManager additions

No new methods needed. The existing API is sufficient:

- `addSpectatorSocket(gameId, socket)` -- already exists
- `getSpectatorCount(gameId)` -- already exists
- `removeSocket(socketId)` -- already handles spectator cleanup, returns `{ role: "spectator" }`
- `isPlayerConnected(gameId, playerId)` -- used for the action guard

Two new methods:

```typescript
/** Check if a socket is registered as a spectator for any game. */
isSpectator(socketId: string): boolean {
  return this.spectatorSocketMeta.has(socketId);
}

/** Get the gameId a spectator socket is watching. Returns null if not a spectator.
 *  Used in handleGameLeave to resolve the actual game being spectated
 *  (prevents mismatched-gameId bugs if payload contains wrong gameId). */
getSpectatorGameId(socketId: string): string | null {
  return this.spectatorSocketMeta.get(socketId) ?? null;
}
```

---

## 4. State Model

### Spectator tracking (in-memory, ConnectionManager)

```
ConnectionManager
  spectatorSockets: Map<gameId, Set<socketId>>     -- existing
  spectatorSocketMeta: Map<socketId, gameId>       -- existing (reverse lookup)
  sockets: Map<socketId, TypedSocket>              -- existing (shared with player sockets)
```

No persistence needed. Spectator state is ephemeral -- if the server restarts, spectators reconnect and rejoin. No spectator identity is tracked (spectators are anonymous viewers).

### Data flow: spectator joins

```
Client emits "game:join" { gameId, role: "spectator" }
  -> handleGameJoin:
     1. Validate game exists
     2. If game.status === "CREATED" -> reject "SPECTATING_NOT_AVAILABLE"
     3. If userId is already a player in this game -> reject (existing behavior)
     4. connectionManager.addSpectatorSocket(gameId, socket)
     5. socket.join(`spectators:${gameId}`)
     6. Emit initial game:spectatorState to this socket (with turnDeadline)
     7. Emit game:spectatorCount to player room (`game:${gameId}`)
     8. ack({ success: true })
```

### Data flow: spectator leaves / disconnects

```
Client emits "game:leave":
  -> handleGameLeave:
     1. connectionManager.getSpectatorGameId(socketId) -> returns gameId (must call BEFORE removeSocket)
     2. socket.leave(`spectators:${gameId}`)
     3. connectionManager.removeSocket(socketId)
     4. Emit game:spectatorCount to player room (`game:${gameId}`)

Socket disconnects:
  -> handleDisconnect:
     1. connectionManager.removeSocket(socketId) -> returns { role: "spectator", gameId }
     2. Emit game:spectatorCount to player room (`game:${gameId}`)
```

### Data flow: game state changes (action applied)

```
handleGameAction / handleTimerExpired:
  -> broadcastGameState (existing):
     1. Emit game:state to each player socket (with spectatorCount... wait, no -- PlayerView doesn't include spectatorCount)
     2. Emit game:spectatorState to `spectators:${gameId}` room (already includes spectatorCount in SpectatorView)
```

Note: `PlayerView` does NOT include `spectatorCount`. Players learn the count via the dedicated `game:spectatorCount` event. This keeps `PlayerView` focused on game state.

---

## 5. Integration Points

### Existing code that already handles spectating correctly

| File | What it does |
|------|-------------|
| `connectionManager.ts` | `addSpectatorSocket`, `removeSocket` (spectator path), `getSpectatorCount` |
| `socketHandler.ts` `handleGameJoin` | Spectator role branch: validates not-a-player, joins spectator room, sends initial state |
| `socketHandler.ts` `broadcastGameState` | Emits `game:spectatorState` to spectator room with enriched view |
| `socketHandler.ts` `handleGameLeave` | Leaves both `game:` and `spectators:` rooms |
| `socketHandler.ts` `handleDisconnect` | Removes socket, identifies spectator role |
| `big2-engine.ts` `getSpectatorView` | Returns public-only state (card counts, no hands) |
| `gameService.ts` `getSpectatorView` | Delegates to engine with spectatorCount |
| `socket-events.ts` | `game:spectatorState` event typed with `EnrichedSpectatorView` |
| `engine-types.ts` | `SpectatorView` interface with `spectatorCount` field |

### Changes needed

| File | Change |
|------|--------|
| `src/shared/socket-events.ts` | Add `game:spectatorCount` event + `SpectatorCountPayload` type + new error codes |
| `src/backend/websocket/socketHandler.ts` | (1) Emit `game:spectatorCount` on spectator join/leave; (2) Add spectator action guard in `handleGameAction` and `handleGameStart`; (3) Reject spectator join for CREATED games; (4) Emit `game:timerExpired` to spectator room |
| `src/backend/websocket/connectionManager.ts` | Add `isSpectator(socketId)` helper method |

---

## 6. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Spectator emits `game:action` | Early-return with `ack({ success: false, error: "SPECTATOR_CANNOT_ACT" })`. No engine/DB call. |
| 2 | Spectator emits `game:start` | Early-return with `ack({ success: false, error: "SPECTATOR_CANNOT_ACT" })`. |
| 3 | Player in game tries to join as spectator | Existing check rejects: "You are already a player in this game". |
| 4 | Spectator tries to join a CREATED (lobby) game | Reject with "SPECTATING_NOT_AVAILABLE" -- nothing to watch yet. |
| 5 | Spectator joins COMPLETED game | Allowed. Receives final `SpectatorView` with scores, winner, and `spectatorCount`. No ongoing updates expected. |
| 6 | Game ends while spectating | Spectator receives final `game:spectatorState` via `broadcastGameState` with `status: "COMPLETED"`, `winner`, and `scores`. |
| 7 | All spectators disconnect | `getSpectatorCount` returns 0. `game:spectatorCount` emitted to players with `count: 0`. No other effect. |
| 8 | Same user opens multiple spectator tabs | Each tab creates a separate socket, each added to spectator room. `getSpectatorCount` counts all sockets. This is correct -- no deduplication needed (spectators are anonymous). |
| 9 | Spectator count overflow (many spectators) | Socket.IO room broadcast is O(1) from the server's perspective (single emit to room). No cap needed. |
| 10 | Spectator joins then game immediately ends (race) | Spectator receives the initial COMPLETED state on join. If the state changes between join validation and state emit, the next `broadcastGameState` delivers the final state. |
| 11 | `game:timerExpired` while spectators are watching | Extended to emit to both `game:${gameId}` and `spectators:${gameId}`. Spectators see who timed out. |
| 12 | Spectator joins but no game state in cache or DB | `gameService.getSpectatorView` returns null, no emit happens. Spectator is in the room and will receive updates when state becomes available. |

---

## 7. Wiring

### socketHandler.ts changes

#### 1. Spectator count notification helper

```typescript
function emitSpectatorCount(
  io: TypedServer,
  gameId: string,
  connectionManager: ConnectionManager,
): void {
  const count = connectionManager.getSpectatorCount(gameId);
  io.to(`game:${gameId}`).emit("game:spectatorCount", { gameId, count });
}
```

#### 2. handleGameJoin spectator branch (modifications to existing)

```typescript
// Existing spectator branch with additions marked:
} else {
  // Spectator
  if (game.playerIds.includes(userId)) {
    ack({ success: false, error: "You are already a player in this game" });
    return;
  }

  // NEW: Reject spectating for games that haven't started
  if (game.status === "CREATED") {
    ack({ success: false, error: "SPECTATING_NOT_AVAILABLE" });
    return;
  }

  connectionManager.addSpectatorSocket(gameId, socket);
  await socket.join(`spectators:${gameId}`);

  // Send initial spectator view (existing, unchanged)
  const spectatorCount = connectionManager.getSpectatorCount(gameId);
  const spectatorView = await gameService.getSpectatorView(gameId, spectatorCount);
  if (spectatorView) {
    const turnDeadline = turnTimerService.getDeadline(gameId);
    socket.emit("game:spectatorState", {
      ...injectConnectionStatus(spectatorView, gameId, connectionManager),
      turnDeadline,
    });
  }

  // NEW: Notify players of updated spectator count
  emitSpectatorCount(io, gameId, connectionManager);

  ack({ success: true });
}
```

#### 3. handleGameAction / handleGameStart — spectator guard

```typescript
// At the top of handleGameAction, after gameId validation:
if (connectionManager.isSpectator(socket.id)) {
  ack({ success: false, error: "SPECTATOR_CANNOT_ACT" });
  return;
}
```

```typescript
// At the top of handleGameStart, after gameId validation:
if (connectionManager.isSpectator(socket.id)) {
  ack({ success: false, error: "SPECTATOR_CANNOT_ACT" });
  return;
}
```

#### 4. handleDisconnect — emit spectator count on spectator disconnect

```typescript
// In handleDisconnect, after removeSocket returns:
if (role === "spectator") {
  emitSpectatorCount(io, gameId, connectionManager);
  return; // No further processing needed for spectators
}
// ... existing player disconnect logic continues
```

#### 5. handleGameLeave — emit spectator count if socket was spectator

```typescript
// In handleGameLeave, detect spectator leave BEFORE removeSocket
// (removeSocket deletes the spectatorSocketMeta entry, so isSpectator/getSpectatorGameId
//  must be called first):
const spectatorGameId = connectionManager.getSpectatorGameId(socket.id);
if (spectatorGameId) {
  socket.leave(`spectators:${spectatorGameId}`);
  connectionManager.removeSocket(socket.id);
  emitSpectatorCount(io, spectatorGameId, connectionManager);
  return; // No further processing for spectators
}
// ... existing player leave logic (uses payload.gameId)
socket.leave(`game:${gameId}`);
connectionManager.removeSocket(socket.id);
```

#### 6. handleTimerExpired — extend game:timerExpired to spectators

```typescript
// Combine player and spectator rooms in a single emit (Socket.IO deduplicates):
io.to(`game:${gameId}`).to(`spectators:${gameId}`).emit("game:timerExpired", timerExpiredPayload);
```

### connectionManager.ts changes

```typescript
/** Check if a socket is registered as a spectator. */
isSpectator(socketId: string): boolean {
  return this.spectatorSocketMeta.has(socketId);
}
```

### socket-events.ts changes

Add to `ServerToClientEvents`:
```typescript
"game:spectatorCount": (payload: SpectatorCountPayload) => void;
```

Add new type:
```typescript
export interface SpectatorCountPayload {
  gameId: string;
  count: number;
}
```

No changes to `SocketErrorCode` — spectator error strings are used only in ack responses as plain literals.

### server.ts and testServer.ts

No changes needed. The existing wiring already passes `connectionManager` and all necessary dependencies to `registerSocketHandlers`. The spectating logic lives entirely within the socket handler and connection manager.

---

## 8. File Organization

```
Modified files:
  src/shared/socket-events.ts                      -- add SpectatorCountPayload, game:spectatorCount event, error codes
  src/backend/websocket/connectionManager.ts       -- add isSpectator() method
  src/backend/websocket/socketHandler.ts           -- spectator count emit, action guard, CREATED rejection, timer event to spectators

No new files. All changes are modifications to existing files.
```

---

## 9. Test Requirements

### Unit tests: ConnectionManager (`tests/websocket/connectionManager.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `isSpectator` returns true for registered spectator socket | After `addSpectatorSocket`, `isSpectator(socketId)` is true |
| 2 | `isSpectator` returns false for player socket | After `addPlayerSocket`, `isSpectator(socketId)` is false |
| 3 | `isSpectator` returns false after spectator disconnect | After `removeSocket`, `isSpectator` returns false |
| 4 | `getSpectatorCount` increments/decrements correctly | Add 2 spectators, count is 2. Remove 1, count is 1. |

### Integration tests: spectating (`tests/integration/spectating.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Spectator joins IN_PROGRESS game and receives `game:spectatorState` | Connect as spectator, verify initial state received with correct fields |
| 2 | Spectator receives `game:spectatorState` on player action | Player plays a card, spectator receives updated state |
| 3 | Spectator receives `turnDeadline` in spectator state | Game has timer, spectator view includes non-null `turnDeadline` |
| 4 | Players receive `game:spectatorCount` when spectator joins | Player listens for event, spectator joins, player receives count |
| 5 | Players receive `game:spectatorCount` when spectator disconnects | Spectator disconnects, player receives updated (decremented) count |
| 6 | Spectator cannot emit `game:action` (rejected with error) | Spectator emits action, receives error ack |
| 7 | Spectator cannot emit `game:start` (rejected with error) | Spectator emits start, receives error ack |
| 8 | Spectator join rejected for CREATED game | Try to spectate a lobby game, receive error |
| 9 | Spectator `game:spectatorState` contains no player hands | Assert `SpectatorView` has `players[].cardCount` but no `hand` or card details |
| 10 | Spectator receives final state when game completes | Play until game ends, spectator gets state with `status: "COMPLETED"` and `scores` |
| 11 | Spectator joins COMPLETED game and receives final state | Join after game ends, receive complete view |
| 12 | Player in game cannot join as spectator | Player attempts `role: "spectator"`, receives error |
| 13 | Multiple spectators receive independent `game:spectatorState` | Two spectators join, both receive state on action |
| 14 | Spectator receives `game:timerExpired` event | Timer fires, spectator gets the timerExpired payload |

### Test infrastructure notes

- Integration tests use the existing `createTestServer` helper -- no changes needed.
- Spectator sockets are created with the same `io(baseUrl, { auth: { token } })` pattern as player sockets. Any authenticated user (guest or registered) can spectate.
- Tests use `FakeTimerProvider` (already exposed by `createTestServer`) for timer-related spectator tests.

---

## 10. Dependencies

- **LLD 3 (WebSocket Layer)** -- spectator room pattern, Socket.IO infrastructure
- **LLD 7a (Turn Timer)** -- `turnDeadline` enrichment for spectator views, `game:timerExpired` event extension
- **Existing code:** `src/backend/websocket/socketHandler.ts`, `src/backend/websocket/connectionManager.ts`, `src/shared/socket-events.ts`, `src/shared/engine-types.ts`, `src/backend/engine/big2/big2-engine.ts`
