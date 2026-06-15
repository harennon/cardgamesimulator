# LLD 8b: Reconnection + Disconnect Handling

Robust connection handling for players who drop or leave mid-game. A disconnected player whose turn timer expires is marked "abandoned" and auto-passed immediately on subsequent turns. Turn timer is required for all games.

---

## 1. Scope

### In scope

- **Turn timer required:** Game creation rejects `turnTimerSeconds: null`. All games must have a timer (30/60/90s). This ensures disconnected players are always eventually timed out.
- **Disconnect detection:** When a player's last socket disconnects during an IN_PROGRESS game, broadcast `game:playerDisconnected` and updated state (showing `isConnected: false`).
- **Abandonment via turn timer:** A disconnected player whose turn timer expires is marked "abandoned." The existing `handleTimerExpired` auto-passes them as normal — no new timer system needed.
- **Immediate auto-pass for abandoned players:** When the turn advances to an already-abandoned player, auto-pass immediately (no waiting for turn timer). Chains through multiple abandoned players.
- **Reconnection:** When a disconnected player reconnects (via `game:join`), clear abandoned status, broadcast `game:playerReconnected`, send current state. Player resumes as normal.
- **Connection status in PlayerView:** `isConnected` on `PlayerPublicInfo` reflects live socket state via `injectConnectionStatus` (already works).
- **handleGameLeave parity:** Explicit `game:leave` during IN_PROGRESS triggers same disconnect handling as socket drop.

### Out of scope

- Spectator reconnection (spectators rejoin fresh — LLD 8a)
- Frontend disconnect UI
- Lobby disconnect (existing behavior: remove from player list)
- Separate grace period timer / `DisconnectTimerService` (eliminated — turn timer serves this purpose)

---

## 2. Approach

### Key technical decisions

1. **No separate grace period timer.** The turn timer IS the grace period. When a player disconnects, their turn timer continues running. If it expires while they're disconnected, they get auto-passed (existing behavior) AND marked abandoned. This eliminates an entire service (`DisconnectTimerService`) and its complexity.

2. **Abandoned = "disconnected when your turn timer expired."** Simple, observable rule. The turn timer expiry is the natural moment to escalate from "temporarily disconnected" to "not coming back."

3. **Turn timer required.** Games must have `turnTimerSeconds` set (30/60/90). Without a timer, a disconnected player would block the game indefinitely. For playtesting this is the right constraint — no-timer games are only useful for dev/testing.

4. **Immediate auto-pass on turn transition.** When the game advances to an already-abandoned player, skip starting the turn timer and auto-pass immediately. This prevents a 30-60s delay on every subsequent turn for someone who's gone.

5. **Reconnection clears abandonment.** Forgiving — the punishment was auto-pass during absence, not permanent exclusion.

6. **In-memory only.** Abandoned status is not persisted. Server restart resets everything; players reconnect.

### How disconnection plays out

```
Player disconnects mid-game:
  → isConnected: false in broadcasts
  → game:playerDisconnected emitted
  → Their turn timer keeps running

Case A: Player reconnects before their timer expires
  → isConnected: true, game:playerReconnected
  → Normal play resumes (never marked abandoned)

Case B: Turn timer expires while disconnected
  → Normal auto-pass via handleTimerExpired (existing)
  → Player marked ABANDONED in ConnectionManager
  → If they reconnect later: abandoned cleared, resume as normal

Case C: Turn advances to already-abandoned player
  → autoPassAbandoned fires immediately (no timer wait)
  → Chains through multiple abandoned players
  → Stops at first connected player, starts their turn timer
```

---

## 3. Interfaces / Types

### ConnectionManager additions

```typescript
// Track which players have been marked abandoned
private readonly abandonedPlayers: Map<string, Set<PlayerId>> = new Map();

/** Mark a player as abandoned (turn timer expired while disconnected). */
markAbandoned(gameId: string, playerId: PlayerId): void {
  if (!this.abandonedPlayers.has(gameId)) {
    this.abandonedPlayers.set(gameId, new Set());
  }
  this.abandonedPlayers.get(gameId)!.add(playerId);
}

/** Clear abandoned status (player reconnected). */
clearAbandoned(gameId: string, playerId: PlayerId): void {
  this.abandonedPlayers.get(gameId)?.delete(playerId);
}

/** Check if a player is abandoned. */
isAbandoned(gameId: string, playerId: PlayerId): boolean {
  return this.abandonedPlayers.get(gameId)?.has(playerId) ?? false;
}

/** Clean up abandoned state for a game. */
clearGameAbandoned(gameId: string): void {
  this.abandonedPlayers.delete(gameId);
}
```

### CreateGame validation change

```typescript
// In src/backend/api/game/createGame.ts:
// turnTimerSeconds is now REQUIRED (not nullable)
// Reject null with 400: "Turn timer is required"
const VALID_TIMER_VALUES = new Set([30, 60, 90]);
```

### Model type change

```typescript
// In src/shared/model.ts:
export interface CreateGameRequest {
  gameType: string;
  maxPlayers: number;
  turnTimerSeconds: 30 | 60 | 90; // No longer nullable
}
```

### No new socket events

`game:playerDisconnected` and `game:playerReconnected` already exist and are already emitted. No changes needed.

---

## 4. State Model

### Player connection states (logical, not persisted)

```
CONNECTED ←→ DISCONNECTED → ABANDONED
     ↑                           |
     └───────────────────────────┘ (reconnection clears abandoned)
```

- **CONNECTED:** Socket present. Normal play.
- **DISCONNECTED:** Socket gone, not yet abandoned. Turn timer still running if it's their turn.
- **ABANDONED:** Turn timer expired while disconnected. Auto-passed immediately on their turn.

Transitions:
- CONNECTED → DISCONNECTED: Last socket for player disconnects (or explicit `game:leave`)
- DISCONNECTED → CONNECTED: Player reconnects via `game:join`
- DISCONNECTED → ABANDONED: Turn timer fires while `isPlayerConnected` is false
- ABANDONED → CONNECTED: Player reconnects (clears abandoned flag)

### Tracking

| State | How tracked |
|-------|------------|
| CONNECTED | `connectionManager.isPlayerConnected(gameId, playerId)` returns true |
| DISCONNECTED | `isPlayerConnected` returns false AND `isAbandoned` returns false |
| ABANDONED | `connectionManager.isAbandoned(gameId, playerId)` returns true |

---

## 5. Integration Points

### handleTimerExpired — mark abandoned on disconnect

After the existing auto-pass logic, check if the player was disconnected. If so, mark them abandoned:

```typescript
// After applying auto-action in handleTimerExpired:
if (!connectionManager.isPlayerConnected(gameId, autoAction.playerId)) {
  connectionManager.markAbandoned(gameId, autoAction.playerId);
}
```

This is the ONLY point where a player becomes abandoned — when their turn timer expires and they're not connected.

### handleGameAction / handleTimerExpired — chain auto-pass for abandoned

After any action advances the turn, check if the new current player is abandoned:

```typescript
if (connectionManager.isAbandoned(gameId, nextPlayer.playerId)) {
  // Skip turn timer, auto-pass immediately
  await autoPassAbandoned(io, gameId, ...);
}
```

### handleGameJoin — clear abandoned on reconnect

```typescript
// In reconnection path:
connectionManager.clearAbandoned(gameId, userId);
io.to(`game:${gameId}`).emit("game:playerReconnected", { playerId: userId, displayName });
await broadcastGameState(...);
```

### handleDisconnect / handleGameLeave — emit disconnect notification

```typescript
// When last socket drops for IN_PROGRESS game:
io.to(`game:${gameId}`).emit("game:playerDisconnected", { playerId: userId, displayName });
await broadcastGameState(...); // Shows isConnected: false
```

### Game completion — clean up abandoned state

```typescript
// When game transitions to COMPLETED:
connectionManager.clearGameAbandoned(gameId);
```

---

## 6. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Disconnect during lobby (CREATED) | No grace period, no abandonment. Existing behavior: emit `lobby:playerLeft`. |
| 2 | Disconnect while it's NOT your turn | `isConnected: false` broadcast. When turn reaches you: if still disconnected, turn timer starts normally. If timer expires while still disconnected → abandoned. |
| 3 | Disconnect while it's your turn | Turn timer keeps running. If it expires → auto-pass + mark abandoned. If you reconnect before → continue as normal. |
| 4 | Multiple players disconnect | Each handled independently. Multiple can be abandoned. `autoPassAbandoned` chains through all of them. |
| 5 | All players disconnect | Game is stuck until someone reconnects. Turn timer fires for current player → abandoned. Next player's timer fires → also abandoned. Eventually all are abandoned and the game effectively stalls (auto-pass loop completes the game). |
| 6 | Reconnect after abandonment | `clearAbandoned` removes the flag. Player resumes normal play. They may have missed multiple turns (auto-passed) but can continue from where the game is now. |
| 7 | Game completes during auto-pass chain | `autoPassAbandoned` checks `status === "COMPLETED"` each iteration. Stops and cleans up. |
| 8 | Rapid disconnect/reconnect (flap) | Disconnect → `game:playerDisconnected` + state broadcast. Reconnect → `game:playerReconnected` + state broadcast. No abandonment (timer didn't expire). |
| 9 | Server restart | All sockets disconnect. All in-memory abandoned state is lost. Players reconnect, game continues fresh. Acceptable for v1. |
| 10 | Player has multiple tabs, closes one | `isPlayerConnected` checks if ANY socket remains. Disconnect event only fires when the LAST socket closes. |
| 11 | `autoPassAbandoned` infinite loop | Bounded by `state.players.length`. If all players are abandoned, the game completes (engine produces COMPLETED when last player passes enough). |
| 12 | Turn timer fires for connected player | Normal flow. Not marked abandoned (they're connected). |

---

## 7. Wiring

### socketHandler.ts — autoPassAbandoned

```typescript
async function autoPassAbandoned(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): Promise<void> {
  const state = await gameService.getGameState(gameId);
  const maxIterations = state?.players.length ?? 4;

  for (let i = 0; i < maxIterations; i++) {
    const currentState = await gameService.getGameState(gameId);
    if (!currentState || currentState.status !== "IN_PROGRESS") return;

    const currentPlayer = currentState.players[currentState.currentPlayerIndex];
    if (!currentPlayer || !connectionManager.isAbandoned(gameId, currentPlayer.playerId)) {
      // Connected player reached — start their turn timer
      if (i > 0) {
        turnTimerService.startTurn(gameId, false);
      }
      return;
    }

    const engine = engineFactory.getEngine(currentState.gameType);
    const autoAction = engine.getAutoTimeoutAction(currentState);
    if (!autoAction) return;

    try {
      await gameService.applyAction(gameId, autoAction);
    } catch {
      return;
    }

    const newState = await gameService.getGameState(gameId);
    if (newState?.status === "COMPLETED") {
      turnTimerService.unregisterGame(gameId);
      connectionManager.clearGameAbandoned(gameId);
      await broadcastGameState(io, gameId, gameService, connectionManager, turnTimerService);
      return;
    }

    await broadcastGameState(io, gameId, gameService, connectionManager, turnTimerService);
  }
}
```

### handleTimerExpired — mark abandoned if disconnected

```typescript
// After applying auto-action:
if (!connectionManager.isPlayerConnected(gameId, autoAction.playerId)) {
  connectionManager.markAbandoned(gameId, autoAction.playerId);
}

// Then check next player:
const newState = await gameService.getGameState(gameId);
if (newState?.status === "COMPLETED") {
  turnTimerService.unregisterGame(gameId);
  connectionManager.clearGameAbandoned(gameId);
} else if (newState) {
  const nextPlayer = newState.players[newState.currentPlayerIndex];
  if (nextPlayer && connectionManager.isAbandoned(gameId, nextPlayer.playerId)) {
    // Next player already abandoned — skip timer, auto-pass chain
  } else {
    turnTimerService.startTurn(gameId, false);
  }
}
await broadcastGameState(...);
await autoPassAbandoned(...);
```

### handleGameAction — check next player after action

```typescript
// After successful applyAction:
if (newState) {
  const nextPlayer = newState.players[newState.currentPlayerIndex];
  if (nextPlayer && connectionManager.isAbandoned(gameId, nextPlayer.playerId)) {
    await broadcastGameState(...);
    await autoPassAbandoned(...);
    ack({ success: true });
    return;
  }
}
// Normal path: start turn timer
turnTimerService.startTurn(gameId, false);
```

### handleGameJoin — clear abandoned on reconnect

```typescript
// In reconnection path (player rejoining IN_PROGRESS game):
connectionManager.clearAbandoned(gameId, userId);
io.to(`game:${gameId}`).emit("game:playerReconnected", { playerId: userId, displayName });
await broadcastGameState(...);
```

### handleDisconnect / handleGameLeave — emit disconnect status

```typescript
// When last socket gone for IN_PROGRESS game:
io.to(`game:${gameId}`).emit("game:playerDisconnected", { playerId: userId, displayName });
await broadcastGameState(...); // isConnected: false visible to other players
```

### server.ts / testServer.ts

No `DisconnectTimerService` needed. The only wiring changes:
- Remove `DisconnectTimerService` instantiation
- Remove `handleGracePeriodExpired` callback
- `registerSocketHandlers` no longer takes a `DisconnectTimerService` parameter

---

## 8. File Organization

```
Removed files:
  src/backend/websocket/disconnectTimerService.ts    — DELETED (no longer needed)
  tests/websocket/disconnectTimerService.test.ts     — DELETED

Modified files:
  src/backend/websocket/connectionManager.ts         — add markAbandoned/clearAbandoned/isAbandoned/clearGameAbandoned
  src/backend/websocket/socketHandler.ts             — autoPassAbandoned, disconnect/reconnect handling, mark abandoned in handleTimerExpired
  src/backend/api/game/createGame.ts                 — reject turnTimerSeconds: null
  src/shared/model.ts                                — CreateGameRequest.turnTimerSeconds no longer nullable
  src/backend/server.ts                              — remove DisconnectTimerService wiring
  tests/integration/helpers/testServer.ts            — remove DisconnectTimerService wiring

New files:
  tests/integration/reconnection.test.ts             — integration tests for disconnect/reconnect flows

Existing test updates:
  tests/websocket/connectionManager.test.ts          — add isAbandoned/markAbandoned/clearAbandoned tests
  tests/api/createGame.test.ts                       — update for required turnTimerSeconds
  tests/integration/turn-timer.test.ts               — update any tests that create games with null timer
```

---

## 9. Test Requirements

### Unit tests: ConnectionManager (`tests/websocket/connectionManager.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `isAbandoned` returns false for connected player | Default state is not abandoned |
| 2 | `markAbandoned` + `isAbandoned` returns true | Flag set correctly |
| 3 | `clearAbandoned` clears the flag | Reconnection path works |
| 4 | `clearGameAbandoned` clears all for game | Game completion cleanup |
| 5 | `clearGameAbandoned` doesn't affect other games | Isolation |

### Integration tests: reconnection (`tests/integration/reconnection.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Disconnect emits `game:playerDisconnected` | Event reaches other players |
| 2 | Disconnect shows `isConnected: false` in state broadcast | Other players see disconnected status |
| 3 | Reconnect emits `game:playerReconnected` | Event reaches other players |
| 4 | Reconnect shows `isConnected: true` in state broadcast | Status restored |
| 5 | Turn timer expiry while disconnected marks abandoned | isAbandoned true after timeout |
| 6 | Abandoned player auto-passed immediately on their turn | No timer delay |
| 7 | Reconnect after abandonment clears abandoned status | Player resumes |
| 8 | Multiple abandoned players chained | Both skipped in sequence |
| 9 | Lobby disconnect — no abandonment | lobby:playerLeft only |
| 10 | Multiple tabs — one close doesn't trigger disconnect | Other tab keeps player connected |
| 11 | Game requires turn timer (null rejected) | POST /createGame returns 400 |
| 12 | Game completes during auto-pass chain | Timers cleaned, final state broadcast |

---

## 10. Dependencies

- **LLD 7a (Turn Timer)** — turn timer expiry is the abandonment trigger
- **LLD 8a (Spectating)** — spectator disconnect handling already complete
- **Existing code:** `connectionManager.ts`, `socketHandler.ts`, `game-engine.ts` (`getAutoTimeoutAction`)
