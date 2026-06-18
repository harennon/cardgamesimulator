# LLD Hotfix: Lobby Player List Not Updating in Real-Time

## Scope

**Covers:** Fixing the race condition where players already in the game lobby do not see newly joined players appear without a manual page refresh.

**Does NOT cover:** Lobby player-left handling (already works via `handleDisconnect`), game start flow, spectator lobby state, or any changes to the game engine.

## Problem Analysis

The lobby player list update relies on the `lobby:playerJoined` WebSocket event emitted inside `handleGameJoin` (socketHandler.ts line 174). The event is broadcast via `socket.to(game:${gameId})` which sends to all sockets in the room except the sender.

**Root cause:** There is a race condition window between when Player A fetches the initial player list via REST and when Player A's WebSocket socket joins the Socket.IO room. Any `lobby:playerJoined` event emitted during this window is lost.

The sequence for a player entering the lobby (`GameView.vue` lines 116-198):

1. `GET /api/getGameState` -- fetches current player list snapshot (line 137)
2. `await connect()` -- creates Socket.IO client instance but does NOT wait for the `connect` event (line 158)
3. Registers `lobby:playerJoined` listener on the socket (line 166)
4. Emits `game:join` -- buffered by Socket.IO until connection established (line 185)
5. ...network latency... connection established, `game:join` sent
6. Server receives `game:join`, calls `await socket.join(game:${gameId})`

**Vulnerability window:** Steps 1 through 6. Any player whose `game:join` is processed by the server during this window will emit `lobby:playerJoined` to the room, but Player A is not yet in the room.

Additionally, even without the race, the server emits `lobby:playerJoined` using the player list from the game loaded at the START of `handleGameJoin`. The `playerCount` field reflects the count at join-ack time which is correct, but if two players join nearly simultaneously, the `playerCount` can be stale (cosmetic issue, not a correctness bug).

## Approach

**Strategy: Server sends authoritative lobby state on room join.**

When a player's `game:join` is processed for a CREATED game, the server should emit the full current player list back to the joining socket (not just the ack). This ensures the joining player has a consistent view regardless of what the REST snapshot showed. Additionally, this allows us to reconcile any players missed during the race window.

This is the minimal fix with the following advantages:
- No new events needed -- reuse the existing `lobby:playerJoined` event or add a small `lobby:state` event
- Server-authoritative (aligns with architecture principles)
- No frontend polling or retry logic
- Works for both the host and joining players

**Chosen approach:** Add a `lobby:state` event that sends the full player list to the joining player immediately upon room join. The frontend reconciles this with the locally-held list.

**Why not just fix the race window?** Waiting for socket connection before fetching REST state would add latency to the lobby render. The current approach (REST fetch + WebSocket subscription) is the standard pattern; it just needs reconciliation at subscription time.

## Interfaces / Types

### New event in `src/shared/socket-events.ts`

```typescript
export interface LobbyStatePayload {
  players: PlayerInfo[];
  maxPlayers: number;
}
```

Add to `ServerToClientEvents`:

```typescript
/** Full lobby state sent to a player upon joining a CREATED game room. */
"lobby:state": (payload: LobbyStatePayload) => void;
```

### No changes to existing events

`lobby:playerJoined` and `lobby:playerLeft` remain as incremental updates for players already subscribed.

## State Model

No new persistent state. The fix operates entirely within the existing WebSocket/in-memory layer.

**Flow after fix (server-side, `handleGameJoin` CREATED branch):**

```
1. Load game from gameService
2. Verify player is in playerIds
3. Register socket in connectionManager
4. Join Socket.IO room
5. Emit lobby:state TO THE JOINING SOCKET (full player list)
6. Emit lobby:playerJoined TO OTHER SOCKETS in room (incremental update)
7. Ack success
```

**Flow after fix (client-side, `GameView.vue`):**

```
1. GET /api/getGameState -> set lobbyPlayers (initial render, may be stale)
2. connect() + register lobby:playerJoined listener (incremental updates)
3. Register lobby:state listener (authoritative reconciliation)
4. Emit game:join
5. On lobby:state received -> REPLACE lobbyPlayers with server-provided list
6. On lobby:playerJoined received -> append if not already present (as today)
```

Step 5 is the key reconciliation: it replaces the potentially-stale REST snapshot with the authoritative server state at the moment the socket joined the room.

## Changes Required

### Backend: `src/backend/websocket/socketHandler.ts`

In `handleGameJoin`, CREATED branch (around line 172-177), after joining the room:

```typescript
if (game.status === "CREATED") {
  // Send full lobby state to the joining socket for reconciliation
  const players: PlayerInfo[] = game.playerIds.map((id) => ({
    playerId: id,
    displayName: game.playerDisplayNames[id] ?? id,
  }));
  socket.emit("lobby:state", { players, maxPlayers: game.maxPlayers });

  // Notify others (incremental update)
  socket.to(`game:${gameId}`).emit("lobby:playerJoined", {
    player: { playerId: userId, displayName },
    playerCount: game.playerIds.length,
  });
  ack({ success: true });
}
```

### Shared: `src/shared/socket-events.ts`

Add `LobbyStatePayload` interface and `lobby:state` to `ServerToClientEvents`.

### Frontend: `src/frontend/component/game/GameView.vue`

Add listener for `lobby:state` after the socket is available:

```typescript
s.on("lobby:state", (payload) => {
  lobbyPlayers.value = payload.players;
  maxPlayers.value = payload.maxPlayers;
});
```

This replaces the REST-fetched `lobbyPlayers` with the authoritative server list, closing the race window.

## Edge Cases

1. **Player joins between REST fetch and socket room join:** Handled -- `lobby:state` on join provides the authoritative list including any players who joined during the window.

2. **Two players join simultaneously:** Each receives the other's `lobby:playerJoined` (if already in room) OR the reconciled `lobby:state` (if joining concurrently). The duplicate check in the `lobby:playerJoined` handler (line 167-170 of GameView.vue) prevents duplicate entries.

3. **Host refreshes the page:** Host re-fetches REST state, re-connects socket, receives `lobby:state` with current players. No stale state.

4. **Player joins a game they're already in (reconnect to lobby):** `handleGameJoin` already handles this idempotently. The `lobby:state` event will send the current list. The `lobby:playerJoined` broadcast still fires to others (benign -- duplicate check in frontend prevents double rendering).

5. **`lobby:state` arrives before REST response:** Not possible -- `game:join` is only emitted after REST fetch completes in the `onMounted` sequence. But even if ordering changed in the future, setting `lobbyPlayers` from either source is safe (last write wins, and `lobby:state` is authoritative).

6. **Socket disconnects and reconnects in lobby:** Socket.IO reconnection re-triggers `connect` but does NOT re-emit `game:join`. The client must re-emit `game:join` on reconnect to rejoin the room and receive `lobby:state`. This is a separate concern (reconnection in CREATED state) -- currently not handled but not in scope for this hotfix.

7. **Mobile slow connection:** The vulnerability window is longer on slow connections, making the bug more likely -- exactly as reported. The fix closes the window regardless of connection speed because reconciliation happens AT join time, not during the window.

## Dependencies

- Existing `GameService.getGame()` -- already loads `playerIds` and `playerDisplayNames`
- Existing `ConnectionManager` -- no changes needed
- Existing `PlayerInfo` type from `@shared/engine-types` -- already defined

No new dependencies.

## Test Requirements

### Unit Tests

1. **socketHandler `handleGameJoin` CREATED branch:** Verify that `socket.emit("lobby:state", ...)` is called with the full player list when a player joins a CREATED game.
2. **socketHandler `handleGameJoin` CREATED branch:** Verify that `socket.to(room).emit("lobby:playerJoined", ...)` is still called for other players.
3. **socketHandler `handleGameJoin` non-CREATED branch:** Verify that `lobby:state` is NOT emitted for IN_PROGRESS or COMPLETED games.

### Integration Tests

4. **Race condition test:** Two players join a CREATED game. Player A joins room first. Player B joins via REST then connects socket. Assert Player A receives `lobby:playerJoined` for Player B. Assert Player B receives `lobby:state` containing both players.
5. **Concurrent join test:** Three players connect sockets and emit `game:join` in rapid succession. Assert all three end up seeing all three players in their lobby (via combination of `lobby:state` and `lobby:playerJoined` events).
6. **Idempotent rejoin:** Player disconnects and reconnects to lobby. Assert `lobby:state` contains current players and no duplicates appear.

### Frontend Component Tests

7. **GameView `lobby:state` handler:** Mock socket emitting `lobby:state` with a player list. Assert `lobbyPlayers` ref is replaced (not appended).
8. **GameView ordering:** Emit `lobby:playerJoined` for player X, then `lobby:state` without player X. Assert final list matches `lobby:state` (authoritative wins).
