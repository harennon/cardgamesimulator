# LLD 13: Railway Sleep-on-Idle

Enable Railway's sleep-on-idle feature (10 min inactivity timeout). LLD 12 removed the persistent DB connection blocker (TypeORM replaced with HTTP-based Supabase SDK). Two in-process blockers remain: `setInterval` loops that keep the Node event loop alive, and a turn timer edge case on wake.

---

## 1. Scope

### In scope

- Remove `setInterval`-based eviction loop from `GameCache`; replace with lazy on-access cleanup
- Remove `setInterval`-based cleanup loop from `GuestSessionStore`; replace with lazy on-access cleanup
- Add turn-deadline recovery logic when game state is hydrated after server sleep
- Flip `sleepApplication: false` to `true` in `railway.json`

### Out of scope

- Changing the `TurnTimerService` interface or `TimerProvider` abstraction
- Persistence changes (DB schema, Supabase SDK usage)
- WebSocket reconnection logic (already handled by LLD 08b)
- Frontend changes

---

## 2. Approach

### 2.1 GameCache: lazy eviction

**Current:** `startEvictionLoop()` runs `setInterval` every 60s to scan and evict inactive entries. This keeps the Node event loop alive even when no requests are flowing.

**Change:** Remove `startEvictionLoop()` / `stopEvictionLoop()` and the `evictionTimer` field entirely. Instead:

1. On `get()`: before returning, check if the entry's `lastAccessedAt` is older than `inactivityThresholdMs`. If so, delete it and return `null`. This is the "expired on read" pattern.
2. On `set()` and `update()`: call `evictInactive()` only when at capacity (`cache.size >= maxEntries`) and the LRU eviction alone is insufficient. This prevents unbounded growth without a timer.
3. Remove `evictionCheckIntervalMs` from `GameCacheConfig` (no longer needed).

**Rationale:** Active games are accessed on every player action (sub-second frequency). Inactive games only matter when they'd block a new entry from being cached. Lazy eviction is sufficient for both cases and adds zero overhead when the server is idle.

### 2.2 GuestSessionStore: lazy cleanup

**Current:** `startCleanupLoop()` runs `setInterval` every 60s to purge expired sessions.

**Change:** Remove `startCleanupLoop()` / `stopCleanupLoop()` and the `cleanupInterval` field. The `get()` method already checks expiry and deletes expired entries (lines 42-44 of the current implementation). The only addition:

1. In `getByGame()`: skip and delete expired sessions encountered during iteration (add the same TTL check already present in `get()`).

No other change needed. The store is already lazy-on-read for individual lookups; it just needs the same treatment for the scan method.

### 2.3 Turn timer recovery on wake

**Problem:** If the server sleeps while a turn timer is running, `setTimeout` is lost. When the first request wakes the server and loads game state from DB, the turn deadline has already elapsed but no timeout handler fires.

**Where to add the check:** In `handleGameJoin` within `socketHandler.ts` (lines 186-212). This is the code path executed when a player reconnects to an IN_PROGRESS game. After loading state and before emitting `game:state`:

1. If the game's `turnTimerSeconds` config is non-null AND `turnTimerService.getDeadline(gameId)` returns `null` (no active timer — lost during sleep) AND `state.status === "IN_PROGRESS"`:
   - Re-register the game with the timer service
   - Compute whether the deadline has already passed by checking a stored `turnDeadline` field (see below)
   - If deadline has passed: immediately invoke the timeout handler (same function used by `TurnTimerService.onTimeout`)
   - If deadline has NOT passed: start a timer for the remaining duration

**Storing the deadline:** The `TurnTimerService` already stores deadlines in its `deadlines` Map, but this is lost on sleep. We need to persist the turn deadline to the game's DB record. Add a `turn_deadline` column (nullable `bigint`, epoch ms) to the `games` table. The socket handler already writes to the DB after each action; the turn deadline is set alongside it.

**Alternative considered (simpler):** Instead of persisting deadlines to DB, treat any missing timer for an IN_PROGRESS timed game as "expired" on reconnect. This avoids a DB schema change. The tradeoff: if the server sleeps and wakes within the turn duration, the player loses their remaining time unfairly.

**Recommendation:** Use the simpler approach. The sleep timeout is 10 minutes. Turn timers are 15s/30s/60s. If no traffic arrives for 10 minutes, no players are actively engaged, so treating the turn as expired is correct behavior. A player reconnecting after 10+ minutes of inactivity should see the timeout resolved, not be given a fresh timer.

**Implementation (simple approach):**

In `handleGameJoin`, after loading game state for an IN_PROGRESS game:

```
if game has turnTimerSeconds configured
  AND turnTimerService has NO active timer for this game (getDeadline returns null)
  AND state.status === "IN_PROGRESS":
    re-register the game timer config
    trigger the timeout handler immediately
    (the timeout handler auto-plays the timed-out player and advances the game)
```

This must happen BEFORE broadcasting state to the reconnecting player, so they see the post-timeout state.

### 2.4 Enable sleep

Flip `sleepApplication: false` to `true` in `railway.json`. No other config change needed. Railway's default idle timeout is 10 minutes (configurable via dashboard, not `railway.json`).

---

## 3. Interfaces / Types

### GameCache (modified)

```typescript
export interface GameCacheConfig {
  maxEntries: number;
  inactivityThresholdMs: number;
  // REMOVED: evictionCheckIntervalMs
}

export class GameCache {
  // REMOVED: evictionTimer field
  // REMOVED: startEvictionLoop()
  // REMOVED: stopEvictionLoop()

  // MODIFIED: get() now checks inactivity threshold before returning
  get(gameId: string): InternalGameState | null;

  // MODIFIED: set() calls evictInactive() when at capacity
  set(gameId: string, state: InternalGameState): void;

  // UNCHANGED: update(), markClean(), evict(), has(), getDirtyEntries()
}
```

### GuestSessionStore (modified)

```typescript
export class GuestSessionStore {
  // REMOVED: cleanupInterval field
  // REMOVED: startCleanupLoop()
  // REMOVED: stopCleanupLoop()

  // UNCHANGED: create(), get(), delete()

  // MODIFIED: getByGame() now deletes expired sessions during iteration
  getByGame(gameId: string): GuestSession[];
}
```

### No new interfaces for timer recovery

The timer recovery logic uses existing `TurnTimerService` methods: `registerGame()`, `getDeadline()`, and the existing `onTimeout` callback wired in `server.ts`.

---

## 4. State Model

No new persistent state. All changes are in-memory behavioral changes.

**Flow after server wake:**

1. Railway receives HTTP/WS request, starts the container
2. Express boots, creates `GameCache` (empty), `GuestSessionStore` (empty), `TurnTimerService` (no timers)
3. Player reconnects via Socket.IO, triggers `handleGameJoin`
4. `gameService.getGameState()` loads from DB into cache (cache miss)
5. Timer recovery check fires: no timer registered for this IN_PROGRESS game with timers configured
6. Timeout handler triggers immediately, auto-playing the timed-out player
7. Updated state is broadcast to the reconnecting player

---

## 5. Edge Cases

1. **Multiple players reconnect simultaneously after wake.** The first `handleGameJoin` to execute the timer recovery path will trigger the timeout. Subsequent joins will see the timer already registered (via `registerGame` + `startTurn` called by the timeout handler's state advancement logic). Use a simple guard: only trigger recovery if `getDeadline(gameId) === null && !turnTimerService.hasTimer(gameId)`.

2. **Game completed while server was asleep (e.g., all remaining players abandoned).** `state.status` will be `COMPLETED`. The recovery check is gated on `status === "IN_PROGRESS"`, so no action taken.

3. **Game has no turn timer configured.** `game.turnTimerSeconds === null`. Recovery check skips immediately.

4. **Cache eviction races with active game.** Lazy eviction on `get()` only evicts entries older than 1 hour (default `inactivityThresholdMs`). Active games are accessed on every action (seconds), so they'll never be evicted. Only truly abandoned games are cleaned up.

5. **GuestSessionStore scan during active game.** `getByGame()` deletes expired sessions inline. This is safe because `Map.delete()` during iteration is well-defined in ES6+ (deleted entries are not revisited).

6. **Railway wakes the server but it's a health check, not a player.** The `/health` endpoint doesn't load game state or trigger socket handlers. No timer recovery occurs. This is fine: if no player is connected, no one observes the stale turn. Recovery triggers on the next real player connection.

---

## 6. Dependencies

- **LLD 12 (Supabase SDK migration):** Must be complete. Removes TypeORM persistent connections. Already merged.
- **LLD 07a (Turn timer):** Provides `TurnTimerService` with `registerGame`, `startTurn`, `getDeadline`, `hasTimer` methods. Already implemented.
- **LLD 08b (Reconnection):** Provides `handleGameJoin` reconnection path and `ConnectionManager.clearAbandoned`. Already implemented.

No new dependencies introduced.

### Callers to update

When removing the interval methods, update these callers:

- `src/backend/server.ts` line 70: remove `this.guestSessionStore.startCleanupLoop()` call
- `src/backend/server.ts` line 140: remove `gameCache.startEvictionLoop()` call
- `src/backend/middleware/authMiddleware.ts` lines 162-163: remove `startCleanupLoop`/`stopCleanupLoop` from `nullStore`
- `src/backend/websocket/socketAuth.ts` lines 97-98: remove `startCleanupLoop`/`stopCleanupLoop` from `nullStore`

---

## 7. Test Requirements

### Unit: GameCache lazy eviction

- `get()` returns `null` for entry older than `inactivityThresholdMs` (entry is deleted)
- `get()` returns state for entry within threshold (entry is kept, `lastAccessedAt` updated)
- `set()` evicts inactive entries when at capacity before inserting
- `set()` evicts LRU when at capacity and no inactive entries exist
- Cache size never exceeds `maxEntries`
- No `setInterval` reference exists after construction (verify with `process._getActiveHandles()` or equivalent)

### Unit: GuestSessionStore lazy cleanup

- `get()` returns `null` and deletes expired session (already tested — verify still passes)
- `getByGame()` excludes expired sessions from results
- `getByGame()` deletes expired sessions encountered during scan
- No `setInterval` reference exists after construction

### Unit: Turn timer recovery

- When `handleGameJoin` loads an IN_PROGRESS game with `turnTimerSeconds` configured and no active timer exists, the timeout handler is invoked
- When timer IS already registered (second player reconnects), no duplicate timeout fires
- When game is COMPLETED, no recovery attempt
- When game has no timer configured, no recovery attempt

### Integration: Sleep simulation

- Start a game with a turn timer, stop all intervals, verify no active handles keep the process alive (use `setTimeout(() => {}, 0)` trick or `process._getActiveHandles().length`)
- Simulate wake: construct fresh services, load game from DB, trigger join, verify timeout fires and game advances

### Regression

- Existing `game-cache.test.ts` tests must pass after removing interval-based eviction
- Existing `guestSessionStore.test.ts` tests must pass after removing interval-based cleanup
- Existing `turnTimerService.test.ts` tests unaffected (no changes to that class)
- Full game E2E tests still pass (timer registration/start happens via socket handler, not via removed loops)
