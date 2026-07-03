# LLD 122: CPU/AI players hang for ~60s and force a default pass after a player wins

Bug fix for LLD 118 / 120 (AI-seat foundation). Backend / socket-layer only. No engine change, no DB change, no migration, no UI change.

## Scope

**Covers:**

1. Fixing `autoPlayAbandoned` (`src/backend/websocket/socketHandler.ts`) so that **no exit path can leave an AI or abandoned seat holding the turn with no turn timer armed.** Every early return that stops on a still-to-be-driven seat while the game is `IN_PROGRESS` must arm a fallback turn timer so the game cannot silently stall for a full timer cycle.
2. A reproduction test (written first) that exercises the real socket path — human wins first, remaining AI seats must continue — with a real `turnTimerSeconds`, and asserts the AI seats advance **synchronously without the turn timer firing** and the game reaches `COMPLETED`.
3. Regression coverage for each `autoPlayAbandoned` early-return branch (auto-action `null`, `applyAction` throws, divergence guard exhausted) proving a timer is armed (or the loop otherwise makes progress) in every branch.
4. Confirming the last-two-players Big2 completion path: the final AI play cleanly transitions to game-over with no timer-forced default action.

**Explicitly does NOT cover:**

- Any change to the pure engine (`big2-engine.ts`, Tonk engine). `getAutoTimeoutAction` and finish/advance logic are correct and stay untouched (architecture principle 4 — engine has no timer/transport awareness).
- Any change to `TurnTimerService`, `GameService`, `StatsService`, `createGame`, or the DB layer.
- Smart AI / move quality (that is #128).
- The root diagnosis is a turn-**scheduling** defect in the socket layer, not a game-rules defect. Fix stays in the socket layer.

## Approach

### Root cause (confirmed by reading the code)

Big2 does not end when the first player empties their hand — play continues among the remaining seats to determine placements; the game only completes when `activePlayers.length <= 1` (`big2-engine.ts:287-327`). So after a human's winning play:

1. `handleGameAction` (`socketHandler.ts:510-554`) re-reads state, sees `status === "IN_PROGRESS"` (not `COMPLETED`), and the now-current seat is an AI seat → it takes the auto-play branch (line 526-554): broadcasts, then calls `autoPlayAbandoned`, and **does not arm a turn timer** (the `startTurn` at line 556 is only reached in the non-auto-play branch). This is intentional — arming is delegated to `autoPlayAbandoned`.
2. `autoPlayAbandoned` (`socketHandler.ts:124-200`) has three early-return paths that exit **before** the `startTurn` call at line 154 (which only runs inside the `!shouldAutoPlay` branch when `i > 0`):
   - **B1 — `getAutoTimeoutAction` returns `null`** (`:160-161`): `return;` with the AI seat still current and no timer armed.
   - **B2 — `applyAction` throws and is swallowed** (`:163-167`): `return;` with no timer armed.
   - **B3 — divergence guard exhausted** (`:193-199`): falls out of the loop, logs a warning, arms no timer.
3. Meanwhile the human's previous turn timer was **never cancelled** on this action (only `startTurn` cancels/restarts a timer, and the auto-play branch skipped it). That stale timer is the ~60s the user observed. When it fires, `handleTimerExpired` → `getAutoTimeoutAction` → `{ type: "pass" }` (`big2-engine.ts:186`) produces the "default pass," and if the next seat is again AI-and-not-driven the game "continues to hang" for another timer cycle.

Net: any `autoPlayAbandoned` early return on a driven seat converts a synchronous AI turn into a ~`turnTimerSeconds`-second stall resolved only by the fallback timer.

### The fix: arm a fallback timer on every non-progress exit

The loop's **happy path already arms the timer** — but only when it *reaches* a non-driven (human) seat after auto-playing (line 152-155). The bug is the exits that stop while a driven seat is still current. The invariant we must guarantee:

> **After `autoPlayAbandoned` returns, if the game is still `IN_PROGRESS`, either (a) the current seat is a human with the turn timer armed, or (b) the current seat is a driven seat with the turn timer armed as a fallback so the next timer tick will drive it.** There is no exit where a driven seat is current and no timer is pending.

Introduce a single helper and call it from all three early-return sites (and keep the existing happy-path arm):

```
armFallbackTimer(gameId, turnTimerService):
  if turnTimerService.hasTimer(gameId):
    turnTimerService.startTurn(gameId, false)   // (re)arms a 1x timer, cancelling any stale one
```

- **B1 (`getAutoTimeoutAction` null):** before `return`, call `armFallbackTimer`. This case should be unreachable for a live current seat in Big2 (a current, non-finished seat always has a legal auto-action; a finished seat is never `currentPlayerIndex`), and Tonk always produces a draw/discard while `IN_PROGRESS` — but if it ever occurs we must not silently stall. Arming lets the timer path retry and surfaces via the normal timer-expired flow rather than a dead game.
- **B2 (`applyAction` throws):** the comment claims "concurrent action already advanced the turn," but that is not guaranteed for AI seats (AI actions are only ever applied here, single-threaded per game in the socket handler; a throw here means the engine rejected the auto-action — a real defect, not a benign race). Before `return`, call `armFallbackTimer` so the seat is retried on the next tick instead of hanging. (We deliberately do not loop-retry synchronously here to avoid a tight infinite loop if the engine keeps rejecting; the timer gives a bounded, observable retry.)
- **B3 (divergence guard exhausted):** replace the current "arm no timer" fail-safe with `armFallbackTimer`. The existing rationale ("do not arm a timer on a still-abandoned seat") is exactly what produces the observed hang. Arming a fallback is strictly safer: it bounds the stall to one timer cycle and routes recovery through the observable `handleTimerExpired` path. Keep the `console.warn` for observability.

Because `startTurn` cancels any existing timer before scheduling (`turnTimerService.ts:37`), calling `armFallbackTimer` also **clears the stale human timer** that caused the observed ~60s — even on the happy path this is already true; the fix extends the same guarantee to the early-return paths.

**Why not also cancel the stale timer in `handleGameAction`'s auto-play branch?** That would be a second valid mitigation (cancel the human timer before delegating to `autoPlayAbandoned`). We do **not** rely on it as the fix because the loop is the correct owner of the timer contract for driven seats, and centralizing the guarantee in `autoPlayAbandoned` covers all callers (`handleGameStart`, `handleGameAction`, `handleTimerExpired`) uniformly with one change. Cancelling in `handleGameAction` alone would leave B1/B2/B3 able to stall via a *different* trigger (e.g. game start with AI first-actor, where there is no stale timer to cancel but also none armed). The loop-centric fix is branch-complete; the handler-side cancel is not.

### Interaction with the happy path (no regression)

- When `autoPlayAbandoned` reaches a human after driving ≥1 AI seat (`i > 0`), it still calls `startTurn(gameId, false)` (line 154) — unchanged.
- When it reaches a human without driving anyone (`i === 0`, e.g. the caller mis-predicted), it still returns without arming (the caller — `handleGameAction` non-auto branch — owns arming in that case). This path is not a driven-seat exit, so the invariant holds. **Refinement:** guard `armFallbackTimer` to only fire when the current seat is actually a driven seat (or use the existing `i > 0` happy-path arm). The three fixed early returns are, by construction, reached only while a driven seat is current, so an unconditional `armFallbackTimer` at those three sites is safe; the `!shouldAutoPlay` branch keeps its existing `i > 0` logic untouched.
- Human-vs-human games never enter `autoPlayAbandoned` unless a seat is abandoned; for abandoned humans the fallback-timer behavior is an improvement (previously B1/B3 could strand an abandoned seat too). The existing turn-timer integration tests (`turn-timer.test.ts`) for the multi-abandoned Big2 chain must still pass unchanged (they exercise the happy path).

### Completion path (last two players) — verify, no code change expected

When the AI's auto-action empties the second-to-last hand, `handlePlayCards` returns `status: "COMPLETED"` (`big2-engine.ts:293-326`). `autoPlayAbandoned`'s `COMPLETED` branch (`:169-181`) already unregisters the timer, clears abandoned, and broadcasts — no fallback timer is armed (correct, the game is over). The fix must not arm a timer when the loop exits via `COMPLETED`; the three fixed sites are all on the `IN_PROGRESS` branch, so this is preserved. A test asserts that after the final AI play the game is `COMPLETED` with `hasTimer(gameId) === false` and no `game:timerExpired` was emitted.

## Interfaces / Types

No public interface changes. One private helper added to `socketHandler.ts`:

```ts
/**
 * Arm a 1x turn timer as a fallback when the auto-play loop exits while a
 * driven seat is still current, so the game advances on the next tick rather
 * than stalling. No-op when the game has no timer configured.
 */
function armFallbackTimer(
  gameId: string,
  turnTimerService: TurnTimerService,
): void;
```

No new socket events, no new error codes, no `GameService` / `StatsService` / engine signature changes.

## State Model

- **In-memory (`TurnTimerService`):** the only state touched. On each fixed early-return, `startTurn(gameId, false)` (re)arms `activeTimers`/`deadlines` for the game (cancelling any stale handle first). No timer is armed on the `COMPLETED` exit (unchanged). `registerGame` config is untouched.
- **In-memory (engine `InternalGameState` / cache):** unchanged. The engine is not modified; `getAutoTimeoutAction`, finish/advance, and completion logic are as-is.
- **Persisted (Supabase):** unchanged. No new writes; the fix only affects in-memory timer scheduling.
- **Broadcast:** on the fallback-timer arm, the subsequent `broadcastGameState` (already called before each early return? — no) is **not** re-issued by the fix; B1/B2/B3 exit without a state change (no action applied), so there is nothing new to broadcast. The pre-existing broadcasts (per successful auto-action, and on completion) are unchanged. The client's `turnDeadline` will refresh on the next broadcast (driven by the fallback timer's `handleTimerExpired`).

## Edge Cases

1. **Human wins first in a 1-human + 1-AI Big2 game; one AI seat remains → game completes on the AI's next play.** The AI seat is driven synchronously by `autoPlayAbandoned` (called from `handleGameAction`), reaches `COMPLETED`, timer unregistered, final broadcast. No timer fires. (Primary reproduction.)
2. **Human wins first in a 1-human + 2-AI Big2 game (4 seats total, human finishes first).** Two AI seats remain; `autoPlayAbandoned` drives both across successive tricks until `activePlayers.length <= 1` → `COMPLETED`. All synchronous; no timer fires. (This is the "continued to hang" scenario pre-fix.)
3. **B1 — `getAutoTimeoutAction` returns `null` mid-loop.** Fallback timer armed; game advances on next tick via `handleTimerExpired` instead of hanging indefinitely. (Should be unreachable in Big2/Tonk for a live seat, but the guarantee holds regardless.)
4. **B2 — `applyAction` throws for an auto-action.** Fallback timer armed; bounded retry on next tick; `console.warn`-style observability retained (the existing swallow is replaced with arm-then-return; log the caught error).
5. **B3 — divergence guard exhausted.** Fallback timer armed (was: none); `console.warn` retained. Bounds the stall to one timer cycle and routes recovery through the observable timer path.
6. **Human-vs-human game, no AI, no abandonment.** `autoPlayAbandoned` is never entered (the post-action `shouldAutoPlay` check is false). Zero behavior change. (Regression-guarded by existing `turn-timer.test.ts`.)
7. **Abandoned-human auto-play (pre-existing feature).** B1/B3 previously could strand an abandoned seat; now they arm a fallback. Existing multi-abandoned-chain integration test still passes (happy path unchanged); the fix only adds arming on the previously-silent exits.
8. **Completion inside the loop.** No fallback timer armed (the `COMPLETED` branch returns before any fixed site). Verified by test asserting `hasTimer === false` post-completion.
9. **Game start with an AI first-actor (LLD 118 path).** `handleGameStart` → `autoPlayAbandoned` with no stale timer. If it drives to a human, happy-path arm fires (unchanged). If it hits B1/B2/B3, fallback arm fires (previously would stall with *no* timer at all — a worse hang than the reported one). Covered by the branch tests.

## Dependencies

- **Must exist (all present):** `autoPlayAbandoned`, `handleGameAction`, `handleGameStart`, `handleTimerExpired` (`socketHandler.ts`); `TurnTimerService.startTurn` / `hasTimer` / `unregisterGame` (`turnTimerService.ts`); `getAutoTimeoutAction` and finish/advance logic (`big2-engine.ts`); `GameService.isAiSeat` / `getAiSeatIds` (LLD 118); `createGame` `numAiSeats` route support (LLD 120); `FakeTimerProvider.fireAll` / `pendingCount` and `TestServerContext` (`tests/integration/helpers/testServer.ts`).
- **No new migration, no schema change, no new dependency.**
- **Blocks nothing;** this is a leaf bug fix on shipped code.

## Test Requirements

Follow testing-principles: self-contained, deterministic (`FakeTimerProvider` — no wall-clock waits), invariant checks, integration smoke to `COMPLETED`. Write the **reproduction test first** (must fail on current `main`, pass after the fix). Tests are automated; no manual table.

### Integration — reproduction (write first; `tests/integration/`, new file e.g. `ai-completion.test.ts`)
- **Repro (primary AC):** Create a Big2 game via the real route with `turnTimerSeconds: 30` and `numAiSeats` seating ≥1 AI plus the human host (use `numAiSeats: 1`, `maxPlayers: 2`, or `numAiSeats: 3`, `maxPlayers: 4` to also cover the "continued to hang" multi-AI case). Connect the human socket, `game:start`, then drive the human's real actions (play from `validActions`) until the human empties their hand and finishes first while `status` stays `IN_PROGRESS`. Assert:
  - (a) After the human's finishing action, remaining AI seats advance **synchronously**: the game reaches `COMPLETED` within the action's `game:state`/ack cycle **without calling `timerProvider.fireAll()`** (the turn timer must never fire). Assert `timerProvider.pendingCount === 0` after completion and that **no `game:timerExpired` event** was received on the human socket.
  - (b) Final `game:state` has `status === "COMPLETED"`, a `winner`, and non-null `scores`.
  - (c) `ctx.turnTimerService.hasTimer(gameId) === false` and `getDeadline(gameId) === null` after completion.
  - This test **fails on current `main`** (the game would only complete after `fireAll()` forces a default pass) and passes after the fix.
- **Last-two-players completion (AC "confirm last-two path"):** In the multi-AI variant, assert the transition to `COMPLETED` happens on an AI play (not on a timer-forced action) — e.g. record the sequence of `game:timerExpired` events and assert it is empty for the whole game.

### Integration / socket-layer — early-return branch regression (`tests/websocket/socketHandler.test.ts`, extend the existing AI describe block; use the existing mock-`GameService` harness)
For each branch, construct a state where the current seat is an AI seat with a timer configured (`hasTimer` mock → true) and assert `turnTimerService.startTurn(gameId, false)` **is called** (fallback armed) — i.e. no branch leaves a driven seat with no timer:
- **B1:** `getGameState` returns an `IN_PROGRESS` state on an AI seat; mock the engine (or state) so `getAutoTimeoutAction` yields `null`. Assert `startTurn(gameId, false)` was called before the loop returned.
- **B2:** `applyAction` rejects (throws) on the AI seat's auto-action. Assert `startTurn(gameId, false)` was called and the throw is logged, not rethrown.
- **B3:** force the divergence guard by making `applyAction` succeed but never advance past a driven seat (state always reports the same AI seat as current). Assert the loop exits after `maxIterations`, logs the warning, **and** calls `startTurn(gameId, false)` (was: never armed).
- **Happy-path regression:** AI seat drives to a human seat → `startTurn(gameId, false)` called exactly once at the human (unchanged); reaching `COMPLETED` → `startTurn` **not** called and `unregisterGame` called.

### Integration — no regression to existing timer/abandonment behavior
- Existing `turn-timer.test.ts` suites (human-vs-human deadlines, single-phase auto-timeout, multi-abandoned chain) must pass unchanged — no new assertions required; run them as the regression gate for the timer contract.
</content>
</invoke>
