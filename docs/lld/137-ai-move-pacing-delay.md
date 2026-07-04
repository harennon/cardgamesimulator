# LLD 137: Make AI/CPU Move Speed Slower (Configurable Pacing Delay)

## Scope

**Problem.** In games with AI/CPU seats, `autoPlayAbandoned()` (`src/backend/websocket/socketHandler.ts`) drives every consecutive auto-seat in a tight synchronous loop with no inter-move delay. All AI moves resolve in one tick, so the client receives their board updates near-simultaneously and a human cannot follow which cards each CPU played.

**Covers (backend/socket layer only):**

1. Inserting a short, non-blocking pace (default ~1000ms, in the AC's 0.8–1.5s band) between **successive auto-driven moves** inside `autoPlayAbandoned`, so each AI/abandoned move broadcasts, then the loop waits, then the next move resolves.
2. An injectable delay seam (`Delayer`) mirroring the existing `TimerProvider` pattern, so tests run with zero real wall-clock delay and existing timing-sensitive integration tests (LLD 122) do not slow down or flake.
3. Threading an optional `aiMoveDelayMs` through `GameConfig` (`src/shared/model.ts`), defaulting to the fixed paced value when absent.

**Explicitly does NOT cover:**

- Any change to AI move *quality/selection* (`getAiMoveAction`, LLD 127) — only *when* moves are applied, not *what* they are.
- Any frontend animation/transition work. This LLD makes the server emit state updates at a human-readable cadence; the client renders each `game:state` as it arrives (no client change required). A create-game UI control to set the delay is out of scope — the value is a fixed default in this pass, with `GameConfig` plumbing so a future UI can set it without a schema change.
- Turn-timer semantics, the divergence/fallback guards, reconnect/timer-recovery, and the LLD 122 completion path — these are **preserved unchanged** (see Edge Cases); this LLD only adds an `await` between iterations.
- Any migration or schema change (`game_config` JSONB is used as-is, per LLD 118).

## Approach

### A. Where the delay goes: between iterations of `autoPlayAbandoned`, after the broadcast

The loop today (lines ~156–235) is: read state → if current seat not driven, arm timer and return → compute auto-action → `applyAction` → on COMPLETED broadcast+return → divergence check → `broadcastGameState` → continue. The **only** change is to `await` a delay **after** a successful `broadcastGameState` and **before** the loop continues to the next iteration:

```
... existing broadcastGameState(...) ...
if (moreDrivenSeatsMayFollow) {
  await delayer.delay(delayMs);   // NEW — paced gap between AI moves
}
// loop continues
```

Rationale for placement:
- **After the broadcast**, so each move is *shown* (state emitted to clients) before the gap. The human sees move N, waits, then sees move N+1.
- **Before the next iteration's state read**, so the gap sits *between* moves, never before the first move (the seat that triggered the loop already had its state broadcast by the caller) and never after the last move.
- **Not** on the COMPLETED branch and **not** on any guard-exit branch (B1/B2/B3), so game-over and fallback arming are never delayed (protects LLD 122 reveal timing and fallback recovery).

The delay is a plain `await` of a promise that resolves after `delayMs`. Because Node is single-threaded and non-blocking, an `await` yields the event loop — **other games' handlers, timer callbacks, and socket events continue to run** during the gap. It does not "stall the engine": the engine is untouched; only this one loop pauses between applying moves for this one game.

### B. Guard on AI presence — zero latency for human-only games (AC hard constraint)

The delay must apply only when the move just applied was an **auto-driven** move (AI or abandoned human). In a human-only game `autoPlayAbandoned` either returns immediately at the first `!shouldAutoPlay` check (i > 0 never reached with a delay) or is never entered on the hot path. To be explicit and defensive:

- The delay is inserted only **inside** the loop body, which is only reached when the current seat satisfied `shouldAutoPlay` (AI or abandoned). A fully human game never executes a loop iteration that applies a move, so it incurs **zero** added latency. No separate guard is needed beyond the loop's existing structure, but the LLD states this as a required invariant: **no `await delayer.delay(...)` may execute on a code path that did not just apply an auto-driven move.**

### C. Delay-before-last-move avoidance

A naive "delay after every broadcast" adds a trailing gap after the final AI move before the loop exits at the human seat (the next iteration reads state, sees the human, arms the timer, returns — the delay from the prior iteration already fired). This trailing gap is harmless (it only postpones arming the human's timer by ~1s) but wasteful. **Recommended:** delay unconditionally after each successful broadcast inside the loop; the trailing ~1s before the human's turn is acceptable and simpler than peeking ahead. The alternative (look ahead to whether the next seat is also driven before delaying) adds an extra state read per iteration for marginal benefit — rejected for simplicity. The human's turn timer is armed *after* the delay resolves, so the deadline the client sees is correct (not skewed early).

### D. The `Delayer` seam (testability — protects LLD 122 timing tests)

`ai-completion.test.ts` asserts the game reaches COMPLETED "synchronously" within the action-ack cycle and that `timerProvider.pendingCount === 0`. A real `setTimeout(1000)` per AI move would make that test wait multiple real seconds and could surface as pending timers. Mirror the existing `TimerProvider` injection:

```ts
// src/backend/websocket/delayer.ts (new)
export interface Delayer {
  /** Resolves after `ms` milliseconds (0 in tests). */
  delay(ms: number): Promise<void>;
}
```

- **Production:** `RealDelayer` → `new Promise((r) => setTimeout(r, ms))`.
- **Tests:** `ImmediateDelayer` → `delay()` returns an already-resolved promise (zero wall-clock). Existing integration/socket tests inject this, so their timing assertions are unaffected and they stay fast. A future test that specifically wants to *assert pacing occurred* can inject a recording fake (`recordedDelays: number[]`).

The `Delayer` is constructed in `server.ts` alongside `RealTimerProvider` and passed into `registerSocketHandlers`, which threads it to `autoPlayAbandoned` and `handleTimerExpired` (the two callers of the loop). This keeps the transport layer thin (architecture principle 9) and the delay a swappable dependency (principle 4/7 spirit: infra is injectable).

### E. Configurable delay via `GameConfig` (AC: expose via GameConfig, default paced)

Add an optional `aiMoveDelayMs` to `GameConfig`:

```ts
export interface GameConfig {
  deckRoundsTarget?: number;
  practice?: boolean;
  aiPlayerIds?: string[];
  aiMoveDelayMs?: number; // NEW: pace between successive auto-driven moves; default DEFAULT_AI_MOVE_DELAY_MS
}
```

- Resolution: `const delayMs = game.gameConfig.aiMoveDelayMs ?? DEFAULT_AI_MOVE_DELAY_MS;` where `DEFAULT_AI_MOVE_DELAY_MS = 1000` is a named constant in `socketHandler.ts` (or a small `constants` module). One read of the already-loaded `Game`/config per loop entry; the loop reuses the resolved `delayMs` for all iterations (immutable during a running game).
- **No create-game UI or route field in this pass.** `CreateGameRequest` is unchanged; `aiMoveDelayMs` is absent for all games created today, so every game uses the default. The field exists so a future create-game control can persist a per-game value with no schema change. A `0` value disables pacing (opt-out); `undefined` uses the default.
- **Clamp defensively:** resolve to `Math.min(Math.max(configured, 0), MAX_AI_MOVE_DELAY_MS)` with `MAX_AI_MOVE_DELAY_MS = 3000`, so a hand-crafted/absurd config cannot hang a game for minutes.

### F. Abandoned-human pacing decision (AC: decide explicitly)

**Decision: apply the same pace to abandoned-human auto-play as to AI seats.** Rationale:
- Readability is the same problem: consecutive abandoned seats (e.g. a mass disconnect) would otherwise flash by identically.
- It does **not** fight the turn timer. The turn timer is *not armed on a driven seat*: `autoPlayAbandoned` arms `startTurn` only when it stops at a *non-driven* (human, connected) seat (`i > 0` branch), and `handleTimerExpired` explicitly skips arming when the next seat is driven ("Skip timer — autoPlayAbandoned will handle this player"). So during the driven run there is no active per-seat timer to race. The pacing gap only postpones the *next* driven move by ~1s; it never delays arming the connected human's timer beyond the last driven move (that arming happens after the final delay resolves). The timer that eventually protects the connected human is armed with a fresh full deadline, unaffected by the pacing.
- The one interaction to verify (Edge Case 4): the loop is re-entered from `handleTimerExpired` after a timer auto-pass advances to a driven seat. The delay lives inside the loop, so a timer-triggered driven run is also paced — consistent and correct.

If a future product decision wants abandoned-human seats to resolve instantly (to "clean up" a dead game faster) while pacing only AI, the code can branch on `isAiSeat` for the delay; this LLD chooses uniform pacing for simplicity and readability and notes the branch point.

## Interfaces / Types

**`src/shared/model.ts` — extend `GameConfig`:**

```ts
export interface GameConfig {
  deckRoundsTarget?: number;
  practice?: boolean;
  aiPlayerIds?: string[];
  aiMoveDelayMs?: number; // pace (ms) between successive auto-driven moves; default 1000, clamp [0, 3000]
}
```

**`src/backend/websocket/delayer.ts` (new):**

```ts
export interface Delayer {
  delay(ms: number): Promise<void>;
}
export class RealDelayer implements Delayer {
  delay(ms: number): Promise<void> {
    return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
  }
}
export class ImmediateDelayer implements Delayer {
  delay(): Promise<void> { return Promise.resolve(); }
}
```

**`src/backend/websocket/socketHandler.ts` — signature threading:**

- New named constants: `DEFAULT_AI_MOVE_DELAY_MS = 1000`, `MAX_AI_MOVE_DELAY_MS = 3000`.
- `autoPlayAbandoned(...)` gains a `delayer: Delayer` parameter (added to its existing arg list). It resolves `delayMs` once from the game's config (via `gameService.getGame(gameId)` — already loaded on entry, or add one read; the config is immutable during play so cache-friendly) and `await delayer.delay(delayMs)` after each in-loop broadcast (per Approach A/C).
- `handleGameStart`, `handleGameAction`, `handleTimerExpired` pass `delayer` through to `autoPlayAbandoned`.
- `registerSocketHandlers(io, gameService, connectionManager, turnTimerService, delayer)` gains a `delayer` parameter, forwarded to every handler. `handleTimerExpired` (exported, called from `server.ts`'s timeout callback) gains a trailing `delayer` parameter.

**`src/backend/server.ts`:**

```ts
this.delayer = new RealDelayer();
const turnTimerService = new TurnTimerService(this.timerProvider, (gameId) => {
  handleTimerExpired(io, gameId, gameService, connectionManager, turnTimerService, this.delayer)
    .catch(...);
});
registerSocketHandlers(io, gameService, connectionManager, turnTimerService, this.delayer);
```

Test server (`tests/.../helpers/testServer.ts` and the unit-test `setupHandlers*` helpers) construct/inject `new ImmediateDelayer()` so all existing tests run at zero delay.

## State Model

- **Persisted (`games.game_config` JSONB):** may now carry `aiMoveDelayMs`. Absent for every existing game and every game created in this pass (no route field), so the default applies universally. No migration — the JSONB round-trip (`mapGame`/`saveGame`) already carries arbitrary config keys (LLD 118).
- **In-memory (engine `InternalGameState`):** unchanged. The engine has no notion of pacing (stays pure — principle 4). The delay is purely a transport-layer scheduling concern.
- **In-memory (socket layer):** the `Delayer` is a stateless singleton per server process. The resolved `delayMs` is a local const per `autoPlayAbandoned` invocation. No new mutable state, no new caches.
- **Turn timer:** unchanged. Deadlines are still set by `startTurn`; the pacing delay never sets/reads a deadline and never appears in `TurnTimerService`.

## Edge Cases

1. **Human-only game.** `autoPlayAbandoned` never applies a move (returns at first `!shouldAutoPlay`), so `delayer.delay` is never called → zero added latency. (AC hard constraint; asserted in tests.)
2. **First-seat-is-AI at game start.** `handleGameStart` → `autoPlayAbandoned` paces the AI run exactly as after a human action. Human-first is unchanged (no loop moves).
3. **Game completes on an AI move mid-loop.** The COMPLETED branch broadcasts and returns **before** any delay — the final winning move is revealed immediately, then the loop exits. No pacing delay is inserted after the completing move, so LLD 122's "final-move reveal / synchronous completion" timing is preserved. `timerProvider.pendingCount` stays 0; the pacing delay is not a `TimerProvider` timer.
4. **Timer-expired re-entry.** `handleTimerExpired` auto-passes an abandoned/timed-out seat, then calls `autoPlayAbandoned`. If the next seat is driven, that run is paced. The timer was not armed on the driven seat (existing skip logic), so no timer races the pacing. When the loop stops at a connected human, `startTurn(false)` arms a fresh full deadline *after* the last delay — correct.
5. **Divergence guard (B3) / null auto-action (B1) / applyAction throws (B2).** All three exit branches `return` **without** delaying (they are before/instead of the in-loop broadcast). `armFallbackTimer` fires immediately, so recovery is never postponed by pacing. The per-seat `maxIterations` ceiling and version-progress check are unchanged (the delay is orthogonal to the loop's iteration count).
6. **Reconnect during a paced AI run.** A human reconnecting mid-run hits `handleGameJoin`, which broadcasts current state and (for IN_PROGRESS) may trigger timer recovery — all independent of the in-flight `autoPlayAbandoned` for AI seats. Because the delay is a non-blocking `await`, the reconnect handler runs during the gap. When the paced loop's next `broadcastGameState` fires, it emits to the (now reconnected) player's socket via the current `getPlayerSockets` snapshot — the reconnected client receives subsequent moves normally. No stall, no missed state (each move is broadcast when applied).
7. **Server sleep/restart mid-run.** In-memory pacing state is a single pending `setTimeout`; if the process restarts, the un-fired delay is lost and the loop for that game stops. This is the *same* failure mode as the existing timer-recovery path: on the next `game:join` the timer-recovery branch (or a fallback timer, if armed) advances the game. Pacing does not introduce a new durability requirement — a paused loop is recovered exactly like a lost timer today.
8. **`aiMoveDelayMs = 0` in config.** `RealDelayer.delay(0)` resolves immediately (fast-path `Promise.resolve()`), reproducing today's instant behavior — an explicit opt-out. Clamp guarantees no negative value.
9. **Absurd configured delay (e.g. 999999).** Clamped to `MAX_AI_MOVE_DELAY_MS` (3000ms) so a bad config cannot make a game appear hung. `maxIterations` still bounds total moves, so worst-case total pacing time is bounded.
10. **Many consecutive AI seats (e.g. 1 human + 7 AI Tonk across a full trick).** Each AI move is paced ~1s apart. This is the desired behavior (human can follow each). Total wall-clock for a long driven run is `moves × delayMs`; bounded by `maxIterations`. Non-blocking, so other games are unaffected.
11. **Spectator watching an AI game.** Spectator `game:spectatorState` is emitted inside the same `broadcastGameState` per move, so spectators also see paced moves — consistent with players.

## Dependencies

- **Must exist (all present):**
  - `autoPlayAbandoned`, `shouldAutoPlay`, `armFallbackTimer`, the B1/B2/B3 guards, and the COMPLETED branch in `socketHandler.ts` (LLD 118 / 122).
  - `TimerProvider` / `RealTimerProvider` / `FakeTimerProvider` injection pattern in `server.ts` (the model this LLD mirrors for `Delayer`).
  - `GameConfig` JSONB round-trip (LLD 118, migration for `game_config`).
  - `getAiMoveAction` / `getAutoTimeoutAction` on both engines (LLD 127 / 118).
- **No new migration.**
- **No upstream LLD blocked; this is additive.** LLD 122 (`ai-completion.test.ts`) and the socket-handler tests must keep passing (they must be updated only to inject the new `delayer` parameter / `ImmediateDelayer`).
- **Does not block** future work; a create-game UI control for delay (if ever wanted) would consume `GameConfig.aiMoveDelayMs`.

## Test Requirements

Follow testing-principles: injected/controlled timing (no real sleeps in tests), self-contained, invariant-preserving. All existing tests must be updated only to pass an `ImmediateDelayer` (or have `registerSocketHandlers`/`handleTimerExpired` default it) so they stay fast and green.

### Unit — `Delayer`
- `RealDelayer.delay(0)` resolves without scheduling a timer (fast path). `RealDelayer.delay(50)` resolves after ~50ms (may use fake timers). `ImmediateDelayer.delay(anything)` resolves immediately.

### Unit — pacing insertion in `autoPlayAbandoned` (socket handler, with a **recording** delayer)
Inject a `RecordingDelayer` capturing every `delay(ms)` call. Reuse the existing `setupHandlersWithAction` harness (extended to inject the delayer).
- **Paced between AI moves:** 1 human + 2 AI where two consecutive AI moves resolve before reaching a human → assert `delay` is called once per applied auto-move (per Approach C), each with the resolved `delayMs`.
- **Zero latency, human-only:** human action advancing to another human (no driven seat) → assert `delay` is **never** called. (AC hard constraint.)
- **Config override:** game with `gameConfig.aiMoveDelayMs = 500` → recorded delays equal 500. Absent config → recorded delays equal `DEFAULT_AI_MOVE_DELAY_MS`. `aiMoveDelayMs = 0` → `delay(0)` recorded (or no-op fast path). Absurd value → clamped to `MAX_AI_MOVE_DELAY_MS`.
- **No delay on completion:** AI move that yields COMPLETED → assert `delay` is **not** called after the completing move (guards LLD 122 timing); `unregisterGame` called, `pendingCount`/fallback unchanged.
- **No delay on guard exits (B1/B2/B3):** for each branch (null auto-action, applyAction throws, version-stall divergence) → assert `armFallbackTimer` (`startTurn(false)`) is called and `delay` is **not** called on that exit (recovery not postponed). These extend the existing B1/B2/B3 regression tests.

### Unit — abandoned-human pacing (Approach F decision)
- Abandoned (not AI) driven seat in the loop → `delay` is called (same pacing as AI), and no turn timer is armed on the driven seat during the run (existing skip preserved). Verifies pacing does not fight the timer.

### Integration — regression (must stay green and fast, LLD 122)
- `ai-completion.test.ts` (1-human + 3-AI and 1-human + 1-AI seeded near-end) runs with `ImmediateDelayer` injected in `testServer`: still reaches COMPLETED synchronously, `timerExpiredEvents` empty, `turnTimerService.hasTimer` false, `timerProvider.pendingCount === 0`. Assert the injected delayer means **no real wall-clock pacing** is added to these tests (they must not regress in runtime).
- **New integration (recording delayer, optional but recommended):** a 1-human + 2-AI Big2 game driven to completion asserts (a) each broadcast between successive AI moves was preceded by a recorded `delay(DEFAULT_AI_MOVE_DELAY_MS)`, (b) card-conservation and status-monotonic invariants hold after each move, (c) completion is reached with a winner — proving pacing is inserted without altering game outcome.

### Integration — timer/reconnect/divergence (highest-risk paths per selection notes)
- **Timer re-entry paced:** existing `turn-timer.test.ts` / `tonk-timer-rearm.test.ts` pass with `ImmediateDelayer`; add/extend one asserting that when `handleTimerExpired` advances to a driven seat the subsequent driven run is paced (recording delayer) yet still completes and arms the human's timer with a full fresh deadline afterward.
- **Reconnection unaffected:** existing `reconnection.test.ts` passes with `ImmediateDelayer`; behavior (state rebroadcast, timer recovery) unchanged because the delay is a non-blocking `await`.

### Not tested (out of scope)
- Real wall-clock 1s delays in CI (would slow the suite; pacing is asserted via recorded `delay(ms)` calls, not by measuring elapsed time — per testing-principle "control timing, don't measure it").
- Frontend rendering cadence (no frontend change; the client renders each `game:state` as received).
