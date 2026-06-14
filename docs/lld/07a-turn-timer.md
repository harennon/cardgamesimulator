# LLD 7a: Turn Timer

Server-side turn timer that auto-passes (or auto-plays lowest card on first/free play) when a player's time expires. The timer runs exclusively on the server, broadcasts an absolute deadline so clients count down locally (zero per-second bandwidth), and is fully testable via an injectable TimerProvider.

---

## 1. Scope

### In scope

- `TurnTimerService` — manages per-game timers using an injectable `TimerProvider`
- Timer lifecycle: register on game start, start/restart on each turn, cancel on game completion
- `getAutoTimeoutAction` method on the `GameEngine` interface — returns the action to apply when time expires
- `Big2Engine.getAutoTimeoutAction` implementation (pass, or play lowest card on first/free play)
- `turnTimerSeconds` field on game creation (null / 30 / 60 / 90)
- `turnDeadline` field added to `PlayerView` and `SpectatorView` emitted via WebSocket (enrichment at the socket layer, not in the engine)
- `game:timerExpired` WebSocket event notifying all players when a timeout fires
- Wiring in `server.ts` and `socketHandler.ts`
- Extended time (2x) for the very first play of the game
- Timer keeps running even if all players disconnect — auto-pass still fires

### Out of scope

- Player stats (LLD 7b)
- Frontend countdown UI (renders from `turnDeadline` — frontend work)
- Pause/resume on disconnect (timer is unconditional once started)
- Configurable per-player timers or chess-clock style time banks

---

## 2. Approach

### Key technical decisions

1. **TimerProvider interface (injectable).** Production uses `setTimeout`/`clearTimeout`. Tests use a `FakeTimerProvider` with manual `fire(gameId)`. This avoids Vitest's fake timers (which cause issues with async code) and keeps timer logic unit-testable without time manipulation.

2. **Timer service takes a callback, not `io` directly.** The `TurnTimerService` is transport-agnostic — it calls an `onTimeout(gameId: string)` callback when a timer fires. The socket layer provides this callback, which applies the auto-action and broadcasts state.

3. **`getAutoTimeoutAction` lives on the engine interface.** This keeps game-specific timeout logic (what to do when time expires) in the engine where game rules live. The timer service does not know about card games.

4. **Absolute deadline broadcast (not countdown).** The server sends `turnDeadline: number` (Unix epoch ms) in each game state emission. The client computes remaining time locally as `turnDeadline - Date.now()`. This means zero ongoing bandwidth for timers and naturally handles network latency.

5. **Race condition mitigation: engine rejects wrong-player actions.** If a player submits an action at the same moment the timer fires, one of two things happens: (a) player action arrives first and is applied — the timer callback finds the turn has advanced and does nothing; (b) timer fires first and auto-passes — the player's late action is rejected by the engine ("Not your turn"). No custom locking needed.

6. **Extended time for first play only.** The first turn of the game gets `turnTimerSeconds * 2` to give players time to assess their hand. All subsequent turns use the configured duration.

7. **Timer survives disconnects.** Once a game is in progress, the timer keeps running regardless of connection status. Auto-timeout actions fire even if no sockets are connected — state is persisted to DB normally.

8. **`turnTimerSeconds` stored on Game entity.** This is a nullable integer column. `null` means no timer. Validated at creation time to be one of: `null`, `30`, `60`, `90`.

---

## 3. Interfaces / Types

### TimerProvider (injectable)

```typescript
// src/backend/timer/timerProvider.ts

export interface TimerHandle {
  readonly id: string; // opaque identifier for cancellation
}

export interface TimerProvider {
  /** Schedule a callback after `ms` milliseconds. Returns a handle for cancellation. */
  schedule(ms: number, callback: () => void): TimerHandle;
  /** Cancel a scheduled timer. No-op if already fired or cancelled. */
  cancel(handle: TimerHandle): void;
}
```

### RealTimerProvider (production)

```typescript
// src/backend/timer/realTimerProvider.ts

export class RealTimerProvider implements TimerProvider {
  private nextId = 0;
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();

  schedule(ms: number, callback: () => void): TimerHandle {
    const id = String(this.nextId++);
    const timeout = setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, ms);
    this.timers.set(id, timeout);
    return { id };
  }

  cancel(handle: TimerHandle): void {
    const timeout = this.timers.get(handle.id);
    if (timeout) {
      clearTimeout(timeout);
      this.timers.delete(handle.id);
    }
  }

  /** Cancel all active timers. Called on server shutdown. */
  cancelAll(): void {
    for (const timeout of this.timers.values()) {
      clearTimeout(timeout);
    }
    this.timers.clear();
  }
}
```

### FakeTimerProvider (tests)

```typescript
// src/backend/timer/fakeTimerProvider.ts

export class FakeTimerProvider implements TimerProvider {
  private nextId = 0;
  private readonly pending: Map<string, { ms: number; callback: () => void }> = new Map();

  schedule(ms: number, callback: () => void): TimerHandle {
    const id = String(this.nextId++);
    this.pending.set(id, { ms, callback });
    return { id };
  }

  cancel(handle: TimerHandle): void {
    this.pending.delete(handle.id);
  }

  /** Manually fire the timer for testing. Returns true if a timer was pending. */
  fire(handleId: string): boolean {
    const entry = this.pending.get(handleId);
    if (!entry) return false;
    this.pending.delete(handleId);
    entry.callback();
    return true;
  }

  /** Fire all pending timers. Returns the count fired. */
  fireAll(): number {
    const entries = [...this.pending.values()];
    this.pending.clear();
    entries.forEach(e => e.callback());
    return entries.length;
  }

  /** Get the number of pending timers. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Get the handle ID of the most recently scheduled timer. */
  get lastScheduledId(): string | null {
    if (this.pending.size === 0) return null;
    return [...this.pending.keys()].pop()!;
  }
}
```

### TurnTimerService

```typescript
// src/backend/timer/turnTimerService.ts

import type { TimerProvider, TimerHandle } from "./timerProvider.js";

export interface TurnTimerConfig {
  /** Seconds per turn. null = no timer. */
  turnTimerSeconds: number | null;
}

export type TimeoutCallback = (gameId: string) => void | Promise<void>;

export class TurnTimerService {
  // gameId -> active timer handle
  private readonly activeTimers: Map<string, TimerHandle> = new Map();
  // gameId -> turnDeadline (epoch ms)
  private readonly deadlines: Map<string, number> = new Map();
  // gameId -> timer config
  private readonly configs: Map<string, TurnTimerConfig> = new Map();

  constructor(
    private readonly timerProvider: TimerProvider,
    private readonly onTimeout: TimeoutCallback,
  ) {}

  /**
   * Register a game's timer configuration. Called once when game starts.
   * Does NOT start the timer — call startTurn() after registration.
   */
  registerGame(gameId: string, config: TurnTimerConfig): void {
    this.configs.set(gameId, config);
  }

  /**
   * Start (or restart) the turn timer for a game.
   * Cancels any existing timer for this game, then schedules a new one.
   * @param isFirstTurn - if true, uses 2x the configured duration
   */
  startTurn(gameId: string, isFirstTurn: boolean): void {
    const config = this.configs.get(gameId);
    if (!config || config.turnTimerSeconds === null) return;

    // Cancel existing timer
    this.cancelTimer(gameId);

    const multiplier = isFirstTurn ? 2 : 1;
    const durationMs = config.turnTimerSeconds * multiplier * 1000;
    const deadline = Date.now() + durationMs;

    this.deadlines.set(gameId, deadline);

    const handle = this.timerProvider.schedule(durationMs, () => {
      this.activeTimers.delete(gameId);
      this.deadlines.delete(gameId);
      this.onTimeout(gameId);
    });

    this.activeTimers.set(gameId, handle);
  }

  /**
   * Cancel the active timer for a game. Called on game completion.
   */
  cancelTimer(gameId: string): void {
    const handle = this.activeTimers.get(gameId);
    if (handle) {
      this.timerProvider.cancel(handle);
      this.activeTimers.delete(gameId);
    }
    this.deadlines.delete(gameId);
  }

  /**
   * Unregister a game entirely. Called on game completion or cache eviction.
   */
  unregisterGame(gameId: string): void {
    this.cancelTimer(gameId);
    this.configs.delete(gameId);
  }

  /**
   * Get the current deadline for a game (epoch ms).
   * Returns null if no timer is active or game has no timer configured.
   */
  getDeadline(gameId: string): number | null {
    return this.deadlines.get(gameId) ?? null;
  }

  /**
   * Check if a game has a timer configured.
   */
  hasTimer(gameId: string): boolean {
    const config = this.configs.get(gameId);
    return config != null && config.turnTimerSeconds !== null;
  }
}
```

### GameEngine interface addition

Add `getAutoTimeoutAction` to the `GameEngine` interface:

```typescript
// Addition to src/backend/engine/game-engine.ts

/**
 * Determine the automatic action to take when the turn timer expires.
 *
 * Contract:
 * - Returns a valid GameAction for the current player
 * - For Big2: returns "pass" when passing is legal, otherwise plays the lowest valid card(s)
 * - Returns null if the game is not in a state where auto-action applies (completed, not started)
 * - Pure derivation — must not modify state
 */
getAutoTimeoutAction(state: InternalGameState): GameAction | null;
```

### Big2Engine.getAutoTimeoutAction implementation

```typescript
// Addition to src/backend/engine/big2/big2-engine.ts

getAutoTimeoutAction(state: InternalGameState): GameAction | null {
  if (state.status !== "IN_PROGRESS") return null;
  if (state.currentPlayerIndex < 0) return null;

  const playerId = state.players[state.currentPlayerIndex]!.playerId;
  const big2State = state.gameSpecificState as Big2State;

  // If player can pass (not first play, not free play), auto-pass
  if (!big2State.isFirstPlayOfGame && !big2State.isFreePlay) {
    return { type: "pass", playerId };
  }

  // Must play (first play or free play) — play the lowest single card
  const hand = big2State.hands[state.currentPlayerIndex] ?? [];
  const sorted = [...hand].sort(compareCards);
  const lowestCard = sorted[0];
  if (!lowestCard) return null;

  return { type: "playCards", playerId, cards: [lowestCard] };
}
```

### Game entity change

Add a nullable column to `Game`:

```typescript
// Addition to src/backend/database/entities/Game.ts

@Column({ type: "int", nullable: true, default: null })
turnTimerSeconds: number | null = null;
```

### SerializableGame change

Add `turnTimerSeconds` so lobby clients can display the timer configuration (the CX doc shows "Timer: 60s per turn" in the lobby wireframe):

```typescript
// Updated src/shared/model.ts

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
```

The serializer (`src/backend/util/serializer.ts`) must include this field from the Game entity:

```typescript
// Updated serializeGameForPlayer in src/backend/util/serializer.ts
export function serializeGameForPlayer(game: Game, _userId: string): SerializableGame {
  return {
    gameId: game.gameId,
    gameType: game.gameType,
    maxPlayers: game.maxPlayers,
    status: game.status,
    playerIds: game.playerIds,
    playerDisplayNames: game.playerDisplayNames,
    state: game.state as SerializableGameState,
    turnTimerSeconds: game.turnTimerSeconds,
  };
}
```

This ensures both the REST `getGameState` endpoint and the WebSocket `lobby:state` event expose the timer configuration to clients.

### CreateGameRequest change

```typescript
// Updated src/shared/model.ts

export interface CreateGameRequest {
  gameType: GameType;
  maxPlayers: number;
  gameOptions: { [key: string]: string };
  turnTimerSeconds?: number | null; // null, 30, 60, or 90
}
```

### Enriched views for WebSocket emission

Rather than modifying the engine's `PlayerView` type (which would violate the pure engine principle), the socket layer enriches the view before emitting:

```typescript
// Addition to src/shared/socket-events.ts

/** PlayerView enriched with timer deadline for WebSocket emission. */
export interface EnrichedPlayerView extends PlayerView {
  readonly turnDeadline: number | null; // epoch ms, or null if no timer
}

/** SpectatorView enriched with timer deadline for WebSocket emission. */
export interface EnrichedSpectatorView extends SpectatorView {
  readonly turnDeadline: number | null;
}
```

Update `ServerToClientEvents`:

```typescript
export interface ServerToClientEvents {
  "game:state": (view: EnrichedPlayerView) => void;
  "game:spectatorState": (view: EnrichedSpectatorView) => void;
  "game:timerExpired": (payload: TimerExpiredPayload) => void;
  // ... existing events unchanged
}

export interface TimerExpiredPayload {
  gameId: string;
  playerId: string; // the player whose turn was auto-acted
  action: "pass" | "playCards"; // what was auto-played
}
```

---

## 4. State Model

### Timer state (in-memory only)

```
TurnTimerService
  configs: Map<gameId, { turnTimerSeconds: number | null }>
  activeTimers: Map<gameId, TimerHandle>
  deadlines: Map<gameId, number>  // epoch ms
```

Timer state is purely in-memory — it does not survive server restarts. On server restart:
- Active games are reloaded from DB on next player connection
- Timers are NOT restored (game continues without timer until next action restarts it)
- This is acceptable for v1: server restarts during gameplay are rare, and the game still functions without the timer (players just won't be auto-timed out for that turn)

### Persistence

The `turnTimerSeconds` config is stored on the `Game` entity and persists with the game. The running timer state (deadline, handle) does not persist.

### Data flow

```
Game creation:
  CreateGameHandler → validates turnTimerSeconds → stores on Game entity

Game start:
  socketHandler.handleGameStart
    → gameService.startGame(...)
    → turnTimerService.registerGame(gameId, { turnTimerSeconds })
    → turnTimerService.startTurn(gameId, isFirstTurn: true)
    → broadcastGameState (includes turnDeadline)

Player action:
  socketHandler.handleGameAction
    → gameService.applyAction(...)
    → if game COMPLETED: turnTimerService.unregisterGame(gameId)
    → else: turnTimerService.startTurn(gameId, isFirstTurn: false)
    → broadcastGameState (includes new turnDeadline)

Timer expires:
  TurnTimerService callback fires
    → onTimeout(gameId) in socketHandler layer
    → engine.getAutoTimeoutAction(state)
    → gameService.applyAction(gameId, autoAction)
    → io.to(`game:${gameId}`).emit("game:timerExpired", payload)
    → if game COMPLETED: turnTimerService.unregisterGame(gameId)
    → else: turnTimerService.startTurn(gameId, isFirstTurn: false)
    → broadcastGameState
```

---

## 5. Wiring

### server.ts changes

```typescript
// In the Server constructor, after creating gameService and connectionManager:

import { RealTimerProvider } from "@/timer/realTimerProvider.js";
import { TurnTimerService } from "@/timer/turnTimerService.js";

// ...inside constructor():
const timerProvider = new RealTimerProvider();
const turnTimerService = new TurnTimerService(timerProvider, (gameId) => {
  handleTimerExpired(this.io, gameId, gameService, connectionManager, turnTimerService).catch(
    (err: unknown) => console.error("Timer expired error", err),
  );
});

registerSocketHandlers(this.io, gameService, connectionManager, turnTimerService);
```

Store `timerProvider` on the Server class for cleanup in `close()`:

```typescript
// In close():
timerProvider.cancelAll();
```

### socketHandler.ts changes

Update `registerSocketHandlers` signature:

```typescript
export function registerSocketHandlers(
  io: TypedServer,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): void { ... }
```

#### handleGameStart — after `gameService.startGame`:

```typescript
// After successful start, register timer and start first turn
const game = await gameService.getGame(gameId);
if (game?.turnTimerSeconds != null) {
  turnTimerService.registerGame(gameId, { turnTimerSeconds: game.turnTimerSeconds });
  turnTimerService.startTurn(gameId, true); // isFirstTurn = true
}
```

#### handleGameAction — after `gameService.applyAction`:

```typescript
// After successful action
const newState = await gameService.getGameState(gameId);
if (newState?.status === "COMPLETED") {
  turnTimerService.unregisterGame(gameId);
} else if (turnTimerService.hasTimer(gameId)) {
  turnTimerService.startTurn(gameId, false);
}
```

#### broadcastGameState — enrich views with turnDeadline:

```typescript
async function broadcastGameState(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): Promise<void> {
  // ... existing logic to get state, engine, playerSockets, spectatorCount ...

  const turnDeadline = turnTimerService.getDeadline(gameId);

  for (const { playerId, socket } of playerSockets) {
    const view = engine.getPlayerView(state, playerId);
    const enriched = { ...injectConnectionStatus(view, gameId, connectionManager), turnDeadline };
    socket.emit("game:state", enriched);
  }

  const spectatorView = engine.getSpectatorView(state, spectatorCount);
  const enrichedSpectator = { ...injectConnectionStatus(spectatorView, gameId, connectionManager), turnDeadline };
  io.to(`spectators:${gameId}`).emit("game:spectatorState", enrichedSpectator);
}
```

#### handleGameJoin — enrich reconnection and spectator views with turnDeadline:

The existing reconnection path (player rejoining an IN_PROGRESS game) and spectator join path currently emit views without `turnDeadline`. Both must be enriched:

```typescript
// Player reconnection path (when game.status !== "CREATED"):
const view = await gameService.getPlayerView(gameId, userId);
if (view) {
  const turnDeadline = turnTimerService.getDeadline(gameId);
  socket.emit(
    "game:state",
    { ...injectConnectionStatus(view, gameId, connectionManager), turnDeadline },
  );
}
```

```typescript
// Spectator join path (when game.status !== "CREATED"):
const spectatorCount = connectionManager.getSpectatorCount(gameId);
const spectatorView = await gameService.getSpectatorView(gameId, spectatorCount);
if (spectatorView) {
  const turnDeadline = turnTimerService.getDeadline(gameId);
  socket.emit(
    "game:spectatorState",
    { ...injectConnectionStatus(spectatorView, gameId, connectionManager), turnDeadline },
  );
}
```

Without this, reconnecting players and newly-joined spectators would not see the countdown timer until the next turn change.

#### handleTimerExpired — new exported function:

```typescript
export async function handleTimerExpired(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): Promise<void> {
  const state = await gameService.getGameState(gameId);
  if (!state || state.status !== "IN_PROGRESS") return;

  const engine = engineFactory.getEngine(state.gameType);
  const autoAction = engine.getAutoTimeoutAction(state);
  if (!autoAction) return;

  try {
    await gameService.applyAction(gameId, autoAction);
  } catch (err: unknown) {
    // If applyAction throws (e.g., optimistic lock error from a concurrent player action
    // that already advanced the turn), return silently. The concurrent action's handler
    // in handleGameAction already restarted the timer for the new turn.
    // No game:timerExpired event is emitted in this case.
    console.warn("Timer auto-action failed (likely concurrent action):", err);
    return;
  }

  // Notify players that a timeout occurred
  const timerExpiredPayload: TimerExpiredPayload = {
    gameId,
    playerId: autoAction.playerId,
    action: autoAction.type as "pass" | "playCards",
  };
  io.to(`game:${gameId}`).emit("game:timerExpired", timerExpiredPayload);

  // Check if game completed after auto-action
  const newState = await gameService.getGameState(gameId);
  if (newState?.status === "COMPLETED") {
    turnTimerService.unregisterGame(gameId);
  } else {
    turnTimerService.startTurn(gameId, false);
  }

  await broadcastGameState(io, gameId, gameService, connectionManager, turnTimerService);
}
```

### createGame handler changes

Update `CreateGameHandler.post` to:
1. Accept `turnTimerSeconds` from the request body
2. Validate it is one of: `null`, `undefined`, `30`, `60`, `90`
3. Pass it to `gameRepo.createGame` (requires updating the repository interface)

```typescript
// Validation in CreateGameHandler:
const VALID_TIMER_VALUES: ReadonlySet<number | null> = new Set([null, 30, 60, 90]);

const turnTimerSeconds = request.body.turnTimerSeconds ?? null;
if (!VALID_TIMER_VALUES.has(turnTimerSeconds)) {
  throw new BadRequestError("turnTimerSeconds must be null, 30, 60, or 90");
}
```

### GameRepository.createGame update

Add `turnTimerSeconds` parameter:

```typescript
createGame(
  gameId: string,
  gameType: GameType,
  creatorId: string,
  maxPlayers: number,
  creatorDisplayName: string,
  turnTimerSeconds: number | null,
): Promise<Game>;
```

---

## 6. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Player submits action at same moment timer fires | Engine rejects wrong-player actions. Whichever arrives second is safely rejected. No locking needed. |
| 2 | Timer fires for a game that is already completed | `handleTimerExpired` checks `state.status !== "IN_PROGRESS"` and returns early. |
| 3 | Timer fires but game was evicted from cache | `gameService.getGameState` reloads from DB. If game not found, returns early. |
| 4 | All players disconnect while timer is running | Timer still fires. Auto-action applied to state and persisted to DB. On reconnect, players see updated state. |
| 5 | Game with `turnTimerSeconds = null` | `registerGame` is called but `startTurn` is a no-op when config is null. No timer is ever scheduled. |
| 6 | First play timeout auto-plays lowest card (which must include the lowest dealt card) | The lowest card in hand IS the lowest dealt card for the starting player in Big2. `getAutoTimeoutAction` returns it as a single. |
| 7 | Free play timeout | `getAutoTimeoutAction` plays the lowest card as a single (valid on free play). |
| 8 | Game has only 1 active player remaining when timer fires | Engine will complete the game. Timer callback detects COMPLETED status and unregisters. |
| 9 | Server restarts mid-game | Timers are lost. Game continues without timer pressure until next action (which restarts the timer). Acceptable for v1. |
| 10 | Timer fires during DB write of a concurrent action | The timer callback loads state from cache first. If the cache has the newer state (action applied), the timer sees the turn has advanced and engine's `getAutoTimeoutAction` returns an action for the new current player — which is correct. If the action hasn't been applied yet (extremely unlikely timing), the timer auto-acts for the original player first, and the concurrent action gets rejected as "not your turn." |
| 11 | `applyAction` throws in `handleTimerExpired` (e.g., optimistic lock error) | `handleTimerExpired` catches the error and returns silently without emitting `game:timerExpired`. This is safe because the concurrent action that caused the conflict already advanced the turn, and its handler in `handleGameAction` already restarted the timer for the new turn. |

---

## 7. Dependencies

- **LLD 4 (Big2 Engine)** — engine must exist to add `getAutoTimeoutAction`
- **LLD 3 (WebSocket Layer)** — socket handler must exist to integrate timer callbacks
- **Existing code:** `src/backend/engine/game-engine.ts`, `src/backend/websocket/socketHandler.ts`, `src/backend/server.ts`, `src/backend/service/gameService.ts`, `src/shared/socket-events.ts`, `src/backend/database/entities/Game.ts`

---

## 8. File Organization

```
src/backend/timer/
  timerProvider.ts          — TimerProvider interface + TimerHandle type
  realTimerProvider.ts      — Production implementation using setTimeout
  fakeTimerProvider.ts      — Test double with manual fire()
  turnTimerService.ts       — Main service (manages per-game timers)

Modified files:
  src/backend/engine/game-engine.ts            — add getAutoTimeoutAction to interface
  src/backend/engine/big2/big2-engine.ts       — implement getAutoTimeoutAction
  src/backend/server.ts                        — instantiate timer service, wire callback
  src/backend/websocket/socketHandler.ts       — integrate timer start/cancel/enrich
  src/backend/database/entities/Game.ts        — add turnTimerSeconds column
  src/backend/database/database.ts             — update createGame signature
  src/backend/database/postgres.ts             — pass turnTimerSeconds in createGame
  src/backend/api/game/createGame.ts           — validate and pass turnTimerSeconds
  src/shared/model.ts                          — add turnTimerSeconds to CreateGameRequest and SerializableGame
  src/backend/util/serializer.ts               — include turnTimerSeconds in serializeGameForPlayer
  src/shared/socket-events.ts                  — add EnrichedPlayerView, EnrichedSpectatorView, TimerExpiredPayload, game:timerExpired event
```

---

## 9. Test Requirements

### Unit tests: TurnTimerService (`tests/timer/turnTimerService.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `startTurn` schedules a timer with correct duration | FakeTimerProvider receives `schedule(60000, ...)` for a 60s config |
| 2 | `startTurn` with `isFirstTurn: true` doubles the duration | FakeTimerProvider receives `schedule(120000, ...)` for a 60s config |
| 3 | `startTurn` cancels previous timer before scheduling new one | After two `startTurn` calls, FakeTimerProvider has only 1 pending timer |
| 4 | Timer expiry calls the `onTimeout` callback with the correct gameId | Fire the fake timer, assert callback was invoked with gameId |
| 5 | `cancelTimer` prevents callback from firing | Cancel, then fire — callback not invoked |
| 6 | `unregisterGame` cancels timer and removes config | After unregister, `hasTimer` returns false, `getDeadline` returns null |
| 7 | `startTurn` is a no-op when `turnTimerSeconds` is null | No timer scheduled, no deadline set |
| 8 | `getDeadline` returns epoch ms of scheduled expiry | Verify returned value is approximately `Date.now() + configured ms` |
| 9 | Multiple games have independent timers | Register two games, fire one timer — only that game's callback fires |

### Unit tests: getAutoTimeoutAction (`tests/engine/big2/autoTimeout.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Returns `pass` when lastPlay exists and not free play | Standard non-free-play timeout auto-passes |
| 2 | Returns `playCards` with lowest card on first play | First play timeout plays the required lowest card |
| 3 | Returns `playCards` with lowest card on free play | Free play timeout plays lowest single |
| 4 | Returns `null` when game is COMPLETED | No action for finished games |
| 5 | Returns `null` when game is CREATED (not started) | No action for games that haven't started |
| 6 | The returned action is valid (passes `validateAction`) | Apply the auto-action — engine accepts it |

### Integration test: timer-driven game advancement (`tests/integration/timer-game.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Game created with `turnTimerSeconds: 60` stores config on Game entity | REST create, then verify via getGame |
| 2 | Game state includes `turnDeadline` after start | Start game via WebSocket, verify `game:state` contains non-null `turnDeadline` |
| 3 | Timer expiry auto-passes and advances turn (using FakeTimerProvider) | Inject fake timer into test server, fire timer, verify game state advanced to next player |
| 4 | `game:timerExpired` event is emitted to all players on timeout | Listen for the event, fire fake timer, verify event received with correct payload |
| 5 | Timer restarts after each action | Play a card, verify new `turnDeadline` in the next `game:state` broadcast |
| 6 | Timer is cancelled on game completion | Play until game ends, verify no pending timers (FakeTimerProvider.pendingCount === 0) |
| 7 | Invalid `turnTimerSeconds` value (e.g., 45) rejected at creation | POST createGame with invalid value returns 400 |
| 8 | Game with `turnTimerSeconds: null` emits `turnDeadline: null` | Create game without timer, verify state has null deadline |

### Test infrastructure notes

- Integration tests that need timer control must use a test server factory that accepts a `TimerProvider` parameter (modify `createTestServer` helper to optionally accept one).
- The `FakeTimerProvider` is imported directly by tests — it lives in production code (`src/backend/timer/fakeTimerProvider.ts`) because it's small and useful for test infrastructure without being a devDependency.
- Timer unit tests require no server, no DB, no WebSocket — just `TurnTimerService` + `FakeTimerProvider`.
