# LLD 8b: Reconnection + Disconnect Handling

Robust connection handling for players who drop or leave mid-game. Tracks disconnect state, provides a grace period before treating a disconnection as abandonment, and auto-passes for permanently disconnected players using the existing timer infrastructure.

---

## 1. Scope

### In scope

- **Disconnect detection:** When a player's last socket disconnects during an IN_PROGRESS game, mark them as disconnected and start a grace period timer.
- **Grace period (30s):** A short window after disconnect during which the player can reconnect without penalty. If their turn arrives during the grace period, the turn timer still runs normally (they may time out via the existing turn timer).
- **Grace period expiry:** When the grace period expires and the player is still disconnected, mark them as "abandoned." From this point, if it becomes their turn, auto-pass immediately (no waiting for the turn timer to expire).
- **Auto-pass on disconnect:** When it is an abandoned player's turn, the server immediately applies `getAutoTimeoutAction` and advances the game. No turn timer delay.
- **Reconnection:** When a disconnected player reconnects (via `game:join` with `role: "player"`), cancel the grace period timer, mark them as connected, broadcast `game:playerReconnected`, and send them current state. This already partially works -- this LLD ensures the grace period is properly cancelled and abandoned status is cleared.
- **Connection status in PlayerView:** The `isConnected` field on `PlayerPublicInfo` already reflects live connection state via `injectConnectionStatus`. This LLD ensures it is accurate for all cases (connected, grace-period disconnected, and abandoned).
- **Connection status broadcast:** `game:playerDisconnected` and `game:playerReconnected` events are already emitted by `socketHandler.ts`. No new events needed.
- **Mid-game permanent departure:** Once abandoned, auto-pass applies for the remainder of the game. If the player reconnects later (even after abandonment), they resume as a normal connected player (abandonment clears on reconnect).
- **Interaction with turn timer:** If the turn timer fires for an abandoned player, the existing `handleTimerExpired` logic works correctly (calls `getAutoTimeoutAction`). The disconnect handling adds immediate auto-pass when it *becomes* an abandoned player's turn, without waiting for the full turn timer duration.

### Out of scope

- Spectator reconnection (spectators just rejoin fresh -- no grace period, no identity tracking. Already handled by LLD 8a.)
- Frontend disconnect UI (showing "Player X disconnected" overlay, reconnection spinner, etc.)
- Lobby disconnect handling (player leaves lobby -- existing behavior removes them from player list, no grace period.)
- Kicking a player from a game
- Replacing a disconnected player with a new player

---

## 2. Approach

### Key technical decisions

1. **Reuse TimerProvider for grace period timers.** The `TimerProvider` interface and `FakeTimerProvider` test double already exist and are proven. A new `DisconnectTimerService` will use the same `TimerProvider` to schedule grace period timers, keeping the pattern consistent and testable.

2. **Separate service from TurnTimerService.** The grace period timer has different semantics from the turn timer (it tracks a player, not a turn; it doesn't restart on action; it only fires once). A dedicated `DisconnectTimerService` is cleaner than overloading `TurnTimerService` with dual responsibilities.

3. **"Abandoned" is an in-memory flag, not a persisted state.** If the server restarts, all players appear disconnected (no sockets). They will reconnect and everything resets. Persisting abandonment status adds complexity for no real benefit -- the game state itself (whose turn, what cards) is already persisted.

4. **Immediate auto-pass on turn transition, not a separate timer.** When the game advances to an abandoned player's turn, the server immediately applies `getAutoTimeoutAction` without starting a turn timer. This eliminates an unnecessary 30-60s delay for each abandoned player's turn. The turn timer is only started for connected (or grace-period) players.

5. **Grace period = 30 seconds.** Short enough that other players are not waiting long, long enough that a brief network glitch or browser refresh doesn't punish the player. Configurable per-game in future if needed, but hardcoded for now.

6. **Reconnection clears abandonment.** If a player reconnects after the grace period expired (i.e., after being marked abandoned), they become a normal connected player again. This is forgiving -- the punishment was auto-pass during their absence, not a permanent ban from the game.

---

## 3. Interfaces / Types

### DisconnectTimerService

```typescript
// src/backend/websocket/disconnectTimerService.ts

import type { TimerProvider, TimerHandle } from "@/timer/timerProvider";
import type { PlayerId } from "@shared/engine-types";

export const DISCONNECT_GRACE_PERIOD_MS = 30_000; // 30 seconds

export type DisconnectCallback = (gameId: string, playerId: PlayerId) => void | Promise<void>;

export class DisconnectTimerService {
  // gameId:playerId -> TimerHandle (for cancellation on reconnect)
  private readonly activeTimers: Map<string, TimerHandle> = new Map();
  // gameId -> Set<PlayerId> (players who have been marked abandoned)
  private readonly abandonedPlayers: Map<string, Set<PlayerId>> = new Map();

  constructor(
    private readonly timerProvider: TimerProvider,
    private readonly onGracePeriodExpired: DisconnectCallback,
  ) {}

  /**
   * Start the grace period for a disconnected player.
   * Called when a player's last socket disconnects during an IN_PROGRESS game.
   * No-op if the player already has a running grace period timer.
   */
  startGracePeriod(gameId: string, playerId: PlayerId): void;

  /**
   * Cancel the grace period for a player (they reconnected).
   * Also clears abandoned status if previously set.
   */
  cancelGracePeriod(gameId: string, playerId: PlayerId): void;

  /**
   * Check if a player has been marked as abandoned (grace period expired).
   */
  isAbandoned(gameId: string, playerId: PlayerId): boolean;

  /**
   * Clean up all timers and state for a game (game completed or evicted).
   */
  unregisterGame(gameId: string): void;
}
```

### Key for activeTimers map

Composite key: `${gameId}:${playerId}` -- each player in each game can have at most one grace period timer.

### No new socket events

All needed events already exist:
- `game:playerDisconnected` -- already emitted in `handleDisconnect` when last socket drops
- `game:playerReconnected` -- already emitted in `handleGameJoin` when a player rejoins an IN_PROGRESS game
- `game:state` -- broadcast after auto-pass actions

### No changes to engine-types.ts

`PlayerPublicInfo.isConnected` already exists and is injected by `injectConnectionStatus` in `socketHandler.ts`. This field already reflects real-time socket presence.

---

## 4. State Model

### Disconnect state machine (per player per game)

```
                    ┌───────────────────────────────────────────────┐
                    │                                               │
                    ▼                                               │
    ┌──────────┐  disconnect  ┌──────────────┐  30s elapsed  ┌──────────┐
    │CONNECTED │ ──────────── │ GRACE_PERIOD │ ─────────────▶│ABANDONED │
    └──────────┘              └──────────────┘               └──────────┘
         ▲                          │                              │
         │       reconnect          │          reconnect           │
         └──────────────────────────┘                              │
         │                                                         │
         └─────────────────────────────────────────────────────────┘
```

**State transitions:**
- **CONNECTED -> GRACE_PERIOD:** Player's last socket disconnects while game is IN_PROGRESS. Grace period timer starts.
- **GRACE_PERIOD -> CONNECTED:** Player reconnects before grace period expires. Timer cancelled, abandoned flag not set.
- **GRACE_PERIOD -> ABANDONED:** Grace period expires. Player marked abandoned. Timer removed.
- **ABANDONED -> CONNECTED:** Player reconnects after grace period. Abandoned flag cleared. Player resumes normally.

### What is stored where

| Data | Location | Lifetime |
|------|----------|----------|
| Socket presence (who has active sockets) | `ConnectionManager.playerSockets` | Until socket disconnects |
| Grace period timers | `DisconnectTimerService.activeTimers` | Until reconnect or expiry |
| Abandoned flag | `DisconnectTimerService.abandonedPlayers` | Until reconnect or game end |
| Connection status in views | Derived at emit-time via `injectConnectionStatus` | Not stored, computed |

### Interaction with turn timer

| Player state | What happens when it's their turn |
|---|---|
| CONNECTED | Normal turn timer starts (existing behavior) |
| GRACE_PERIOD | Normal turn timer starts (player might reconnect and play in time) |
| ABANDONED | No turn timer. Immediate auto-pass via `getAutoTimeoutAction`. |

---

## 5. Integration Points

### Existing code that participates

| File | Role |
|------|------|
| `socketHandler.ts` `handleDisconnect` | Detects last-socket disconnect, emits `game:playerDisconnected`. **Modified** to start grace period. |
| `socketHandler.ts` `handleGameJoin` | Handles reconnection (player rejoins IN_PROGRESS game). **Modified** to cancel grace period and clear abandonment. |
| `socketHandler.ts` `handleGameAction` | After action applied, calls `turnTimerService.startTurn`. **Modified** to check if next player is abandoned and auto-pass. |
| `socketHandler.ts` `handleTimerExpired` | Fires auto-action for timed-out player. **No change** -- already calls `getAutoTimeoutAction`. |
| `socketHandler.ts` `broadcastGameState` | Broadcasts state with `injectConnectionStatus`. **No change**. |
| `connectionManager.ts` `isPlayerConnected` | Returns true if player has active sockets. **No change**. |
| `timerProvider.ts` / `fakeTimerProvider.ts` | Used by DisconnectTimerService. **No change**. |
| `turnTimerService.ts` | Manages turn timers. **No change to its code**, but callers conditionally skip `startTurn` for abandoned players. |
| `gameService.ts` `applyAction` | Applies action to engine. **No change**. |
| `game-engine.ts` `getAutoTimeoutAction` | Returns auto-action for current player. **No change**. |

### New code

| File | Purpose |
|------|---------|
| `src/backend/websocket/disconnectTimerService.ts` | Grace period timer management and abandonment tracking |

---

## 6. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Player disconnects during CREATED (lobby) game | No grace period. Existing behavior: `lobby:playerLeft` emitted. DisconnectTimerService only activates for IN_PROGRESS games. |
| 2 | Player disconnects during COMPLETED game | No grace period. Game is over -- no turns to auto-pass. |
| 3 | Multiple tabs: one tab closes but another remains open | `connectionManager.isPlayerConnected` returns true (other socket still in set). No disconnect event emitted, no grace period started. |
| 4 | Player reconnects during grace period | `cancelGracePeriod` called, timer cancelled, `game:playerReconnected` emitted, full state sent. Player continues normally. |
| 5 | Player reconnects after abandonment | `cancelGracePeriod` called (clears abandoned flag), `game:playerReconnected` emitted. If it's currently their turn and they reconnected before auto-pass fired, they get their normal turn. |
| 6 | It's abandoned player's turn: concurrent reconnect race | The auto-pass loop checks `isAbandoned` before each auto-pass. If the player reconnects between one auto-pass and the next turn arrival, the check fails and they get their turn normally. |
| 7 | Grace period expires but it's not the player's turn | Player marked abandoned. Nothing else happens immediately. When their turn eventually arrives, auto-pass fires. |
| 8 | Grace period expires and it IS the player's turn | Player marked abandoned. The grace period callback checks if it's currently their turn and fires auto-pass immediately. Then the next player's turn starts. |
| 9 | All players disconnect | Each gets their own grace period. If the current player's grace period expires, auto-pass fires. Game continues via auto-pass chain until all abandoned players are processed or game completes. |
| 10 | Auto-pass chain: abandoned player A's turn auto-passed to abandoned player B | After auto-passing for A, the code checks if the new current player (B) is also abandoned and auto-passes for them too. This loop continues until a connected/grace-period player's turn or game completion. Bounded by player count (max 4 iterations). |
| 11 | Game completes during auto-pass chain | After each `applyAction`, check `status === "COMPLETED"`. If so, stop the chain, unregister timers, broadcast final state. |
| 12 | Server restarts mid-game | All in-memory state (grace periods, abandoned flags) is lost. Players reconnect from scratch -- everyone starts as connected. If a player never reconnects, they stay disconnected (no sockets) but the grace period won't have started. The turn timer handles their timeout via normal expiry. Acceptable degradation. |
| 13 | Timer expiry race: turn timer and grace period fire simultaneously | Both paths converge on `getAutoTimeoutAction`. The `applyAction` call uses optimistic locking (version check). If both attempt to apply, one succeeds and the other sees a version mismatch or "not your turn" error and returns silently. |
| 14 | Game with no turn timer, player abandons | Grace period still applies (30s). After abandonment, immediate auto-pass on their turn. The lack of a turn timer doesn't affect disconnect handling -- auto-pass is triggered by the disconnect system, not the turn timer. |
| 15 | Player disconnects, reconnects, disconnects again | Each disconnect restarts the grace period fresh. Abandoned flag is cleared on reconnect, then a new grace period begins on the subsequent disconnect. |

---

## 7. Wiring

### DisconnectTimerService implementation

```typescript
// src/backend/websocket/disconnectTimerService.ts

export class DisconnectTimerService {
  private readonly activeTimers: Map<string, TimerHandle> = new Map();
  private readonly abandonedPlayers: Map<string, Set<PlayerId>> = new Map();

  constructor(
    private readonly timerProvider: TimerProvider,
    private readonly onGracePeriodExpired: DisconnectCallback,
  ) {}

  private key(gameId: string, playerId: PlayerId): string {
    return `${gameId}:${playerId}`;
  }

  startGracePeriod(gameId: string, playerId: PlayerId): void {
    const k = this.key(gameId, playerId);
    if (this.activeTimers.has(k)) return; // Already running

    const handle = this.timerProvider.schedule(DISCONNECT_GRACE_PERIOD_MS, () => {
      this.activeTimers.delete(k);
      // Mark player as abandoned
      if (!this.abandonedPlayers.has(gameId)) {
        this.abandonedPlayers.set(gameId, new Set());
      }
      this.abandonedPlayers.get(gameId)!.add(playerId);
      this.onGracePeriodExpired(gameId, playerId);
    });

    this.activeTimers.set(k, handle);
  }

  cancelGracePeriod(gameId: string, playerId: PlayerId): void {
    const k = this.key(gameId, playerId);
    const handle = this.activeTimers.get(k);
    if (handle) {
      this.timerProvider.cancel(handle);
      this.activeTimers.delete(k);
    }
    // Clear abandoned status on reconnect
    this.abandonedPlayers.get(gameId)?.delete(playerId);
  }

  isAbandoned(gameId: string, playerId: PlayerId): boolean {
    return this.abandonedPlayers.get(gameId)?.has(playerId) ?? false;
  }

  unregisterGame(gameId: string): void {
    // Cancel all grace period timers for this game
    for (const [k, handle] of this.activeTimers.entries()) {
      if (k.startsWith(`${gameId}:`)) {
        this.timerProvider.cancel(handle);
        this.activeTimers.delete(k);
      }
    }
    this.abandonedPlayers.delete(gameId);
  }
}
```

### socketHandler.ts modifications

#### 1. New: auto-pass loop for abandoned players

```typescript
/**
 * After a state change, if the new current player is abandoned, auto-pass immediately.
 * Loops until a non-abandoned player's turn or game completion.
 */
async function autoPassAbandoned(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  disconnectTimerService: DisconnectTimerService,
): Promise<void> {
  // Loop bounded by player count to prevent infinite loops
  for (let i = 0; i < 4; i++) {
    const state = await gameService.getGameState(gameId);
    if (!state || state.status !== "IN_PROGRESS") return;

    const currentPlayer = state.players[state.currentPlayerIndex];
    if (!disconnectTimerService.isAbandoned(gameId, currentPlayer.playerId)) {
      return; // Current player is connected or in grace period — stop
    }

    const engine = engineFactory.getEngine(state.gameType);
    const autoAction = engine.getAutoTimeoutAction(state);
    if (!autoAction) return;

    try {
      await gameService.applyAction(gameId, autoAction);
    } catch {
      return; // Concurrent action already advanced the turn
    }

    const newState = await gameService.getGameState(gameId);
    if (newState?.status === "COMPLETED") {
      turnTimerService.unregisterGame(gameId);
      disconnectTimerService.unregisterGame(gameId);
      await broadcastGameState(io, gameId, gameService, connectionManager, turnTimerService);
      return;
    }

    await broadcastGameState(io, gameId, gameService, connectionManager, turnTimerService);
    // Loop continues to check the next player
  }
}
```

#### 2. Modified: handleDisconnect — start grace period

```typescript
async function handleDisconnect(
  socket: TypedSocket,
  io: TypedServer,
  connectionManager: ConnectionManager,
  gameService: GameService,
  disconnectTimerService: DisconnectTimerService,
): Promise<void> {
  const meta = connectionManager.removeSocket(socket.id);
  if (!meta) return;

  const { gameId, playerId, role } = meta;

  if (role === "spectator") {
    emitSpectatorCount(io, gameId, connectionManager);
    return;
  }

  if (role === "player" && !connectionManager.isPlayerConnected(gameId, playerId)) {
    const displayName = socket.data.displayName;
    const game = await gameService.getGame(gameId);

    if (game && game.status === "CREATED") {
      io.to(`game:${gameId}`).emit("lobby:playerLeft", {
        playerId,
        playerCount: game.playerIds.length,
      });
    } else if (game && game.status === "IN_PROGRESS") {
      io.to(`game:${gameId}`).emit("game:playerDisconnected", {
        playerId,
        displayName,
      });
      // NEW: Start grace period for IN_PROGRESS games
      disconnectTimerService.startGracePeriod(gameId, playerId);
      // Broadcast updated connection status to all players
      await broadcastGameState(io, gameId, gameService, connectionManager, turnTimerService);
    }
  }
}
```

#### 3. Modified: handleGameJoin — cancel grace period on reconnect

In the player branch for IN_PROGRESS games, add:

```typescript
// After connectionManager.addPlayerSocket and before sending state:
disconnectTimerService.cancelGracePeriod(gameId, userId);
```

#### 4. Modified: handleGameAction — check abandoned after action

After the successful `applyAction` and before/after `broadcastGameState`:

```typescript
// After starting turn timer for the new current player:
if (newState?.status !== "COMPLETED" && turnTimerService.hasTimer(gameId)) {
  // Check if new current player is abandoned — skip turn timer, auto-pass instead
  const nextPlayer = newState!.players[newState!.currentPlayerIndex];
  if (disconnectTimerService.isAbandoned(gameId, nextPlayer.playerId)) {
    turnTimerService.cancelTimer(gameId); // Don't start timer for abandoned player
    await broadcastGameState(io, gameId, gameService, connectionManager, turnTimerService);
    await autoPassAbandoned(io, gameId, gameService, connectionManager, turnTimerService, disconnectTimerService);
    ack({ success: true });
    return;
  }
  turnTimerService.startTurn(gameId, false);
}
```

#### 5. Modified: handleTimerExpired — chain auto-pass after timer expiry

After the existing timer expiry logic applies the auto-action:

```typescript
// After broadcastGameState and timer restart:
await autoPassAbandoned(io, gameId, gameService, connectionManager, turnTimerService, disconnectTimerService);
```

#### 6. Grace period expiry callback

Wired during service construction:

```typescript
const disconnectTimerService = new DisconnectTimerService(timerProvider, async (gameId, playerId) => {
  // Grace period expired — player is now abandoned
  // If it's currently their turn, auto-pass immediately
  const state = await gameService.getGameState(gameId);
  if (!state || state.status !== "IN_PROGRESS") return;

  const currentPlayer = state.players[state.currentPlayerIndex];
  if (currentPlayer.playerId === playerId) {
    // Cancel any running turn timer (we'll auto-pass immediately)
    turnTimerService.cancelTimer(gameId);
    await autoPassAbandoned(io, gameId, gameService, connectionManager, turnTimerService, disconnectTimerService);
  }
  // If it's not their turn, nothing to do now. Auto-pass will trigger when their turn arrives.
});
```

#### 7. Modified: handleGameStart — start grace period check

After game starts, if any player is already disconnected (joined lobby but disconnected before start), immediately start their grace period:

```typescript
// After game start, after timer registration:
for (const pid of game.playerIds) {
  if (!connectionManager.isPlayerConnected(gameId, pid)) {
    disconnectTimerService.startGracePeriod(gameId, pid);
  }
}
```

#### 8. Game completion cleanup

In `handleGameAction` and `handleTimerExpired`, when `newState.status === "COMPLETED"`:

```typescript
turnTimerService.unregisterGame(gameId);
disconnectTimerService.unregisterGame(gameId);
```

### server.ts and testServer.ts modifications

Both need to:
1. Instantiate `DisconnectTimerService` with the same `TimerProvider` as `TurnTimerService`
2. Pass it to `registerSocketHandlers`

`registerSocketHandlers` signature changes:

```typescript
export function registerSocketHandlers(
  io: TypedServer,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  disconnectTimerService: DisconnectTimerService,
): void;
```

`TestServerContext` gets a new field:

```typescript
export interface TestServerContext {
  // ... existing fields ...
  disconnectTimerService: DisconnectTimerService;
}
```

---

## 8. File Organization

```
New files:
  src/backend/websocket/disconnectTimerService.ts   -- Grace period + abandonment tracking

Modified files:
  src/backend/websocket/socketHandler.ts            -- Grace period start/cancel, auto-pass loop, dependency injection
  src/backend/server.ts                             -- Instantiate DisconnectTimerService, pass to handlers
  tests/integration/helpers/testServer.ts           -- Same wiring for test server

Test files:
  tests/websocket/disconnectTimerService.test.ts    -- Unit tests for DisconnectTimerService
  tests/integration/reconnection.test.ts            -- Integration tests for disconnect/reconnect flows
```

---

## 9. Test Requirements

### Unit tests: DisconnectTimerService (`tests/websocket/disconnectTimerService.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `startGracePeriod` schedules a timer via TimerProvider | After calling, `FakeTimerProvider.pendingCount` increases by 1 |
| 2 | `startGracePeriod` is idempotent (second call is no-op) | Calling twice for same player does not create a second timer |
| 3 | `cancelGracePeriod` cancels the timer | After cancel, `FakeTimerProvider.pendingCount` decreases. Timer callback never fires. |
| 4 | `cancelGracePeriod` clears abandoned status | Mark abandoned (fire timer), reconnect (cancel), `isAbandoned` returns false |
| 5 | Timer fire marks player as abandoned | Fire the timer, `isAbandoned` returns true |
| 6 | Timer fire calls `onGracePeriodExpired` callback | Verify callback invoked with correct gameId and playerId |
| 7 | `isAbandoned` returns false for connected player | No grace period started, returns false |
| 8 | `isAbandoned` returns false during grace period (not yet expired) | Timer scheduled but not fired, returns false |
| 9 | `unregisterGame` cancels all timers for that game | Two players disconnected, unregister game, both timers cancelled, both abandoned flags cleared |
| 10 | `unregisterGame` does not affect other games | Two games with disconnected players, unregister one, other game's timers still active |
| 11 | `cancelGracePeriod` for player with no timer is a no-op | Does not throw or corrupt state |

### Integration tests: reconnection (`tests/integration/reconnection.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Player disconnects, others receive `game:playerDisconnected` | Disconnect one player's socket, verify others get the event with correct playerId |
| 2 | Player disconnects, `isConnected: false` in next state broadcast | After disconnect, check players' received `game:state` shows `isConnected: false` for disconnected player |
| 3 | Player reconnects within grace period, receives current state | Disconnect, wait < 30s, reconnect via `game:join`, verify full state received |
| 4 | Player reconnects within grace period, others receive `game:playerReconnected` | Verify the reconnection event is broadcast with correct playerId |
| 5 | Player reconnects, `isConnected: true` in next state broadcast | After reconnect, verify players' `game:state` shows `isConnected: true` |
| 6 | Grace period expires, player marked abandoned, auto-pass on their turn | Disconnect a player whose turn it is, fire grace period timer, verify auto-action applied and game advances |
| 7 | Grace period expires, not their turn yet, auto-pass when turn arrives | Disconnect player B, fire grace period. Player A takes action that advances to B's turn. Verify B is auto-passed immediately. |
| 8 | Auto-pass chain: multiple abandoned players | Disconnect players B and C. Fire both grace periods. When turn reaches B, verify B and C are both auto-passed in sequence. |
| 9 | Reconnect after abandonment clears abandoned status | Disconnect, fire grace period, reconnect. Verify the player can act normally on their next turn (not auto-passed). |
| 10 | Game completes during auto-pass chain | Set up state near completion, disconnect players, fire grace periods. Verify game completes and timers are cleaned up. |
| 11 | Turn timer fires for grace-period player (not yet abandoned) | Disconnect player during their turn. Turn timer fires before grace period expires. Verify normal auto-pass (same as LLD 7a timer behavior). |
| 12 | No grace period for CREATED game disconnect | Player disconnects from lobby. Verify no grace period timer started (check FakeTimerProvider). |
| 13 | No grace period for COMPLETED game disconnect | Game ends, player disconnects. Verify no grace period timer started. |
| 14 | Multiple tabs: one tab disconnects, player stays connected | Connect two sockets for same player. Disconnect one. Verify no `game:playerDisconnected` emitted, no grace period started. |
| 15 | Player disconnects and reconnects rapidly (flapping) | Disconnect, reconnect immediately, disconnect again. Verify a new grace period starts on the second disconnect. |
| 16 | Game with no turn timer, abandoned player auto-passed | Create game with `turnTimerSeconds: null`. Disconnect player, fire grace period. Verify auto-pass still works on their turn. |

### Test infrastructure notes

- All tests use `FakeTimerProvider` for both turn timers and grace periods (same provider instance shared by both services).
- Tests fire grace period timers explicitly via `FakeTimerProvider.fire(handleId)` or `fireAll()`.
- `TestServerContext` exposes `disconnectTimerService` for direct inspection in tests (e.g., checking `isAbandoned`).
- Socket disconnection in tests: call `socket.disconnect()` on the client socket, which triggers the server's `disconnect` event.

---

## 10. Dependencies

- **LLD 3 (WebSocket Layer)** -- Socket.IO room management, `ConnectionManager`, disconnect handling
- **LLD 7a (Turn Timer)** -- `TimerProvider` interface, `FakeTimerProvider`, `TurnTimerService` (reused pattern, not modified)
- **LLD 8a (Spectating)** -- `registerSocketHandlers` signature (this LLD extends it with a new parameter)
- **Existing code:** `src/backend/websocket/socketHandler.ts`, `src/backend/websocket/connectionManager.ts`, `src/backend/timer/timerProvider.ts`, `src/backend/timer/fakeTimerProvider.ts`, `src/backend/engine/game-engine.ts` (`getAutoTimeoutAction`)
