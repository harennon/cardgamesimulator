# LLD 122: CPU/AI players hang for ~60s and force a default pass after a player wins

Bug fix for LLD 118 / 120 (AI-seat foundation). Backend / socket-layer only. No engine change, no DB change, no migration, no UI change.

## Scope

**Covers:**

1. **Correctly sizing the `autoPlayAbandoned` loop bound** (`src/backend/websocket/socketHandler.ts`) so the loop drives the remaining driven seats all the way to a human turn or `COMPLETED` **regardless of how many turns that takes.** The current per-seat divergence guard (`playerCount * MAX_AUTO_ACTIONS_PER_SEAT`) is the primary root cause: after a human finishes early, the remaining AI seats must play out **many** tricks to determine placements, which exceeds the tiny cap, so the loop bails out (branch B3) while an AI seat is still current. This is the concrete branch that reproduces the reported hang.
2. Fixing `autoPlayAbandoned` so that **no exit path leaves a driven (AI/abandoned) seat holding the turn with no turn timer armed** in timer-configured games — a defense-in-depth guarantee layered on top of the loop-bound fix. Every early return that stops on a still-to-be-driven seat while the game is `IN_PROGRESS` arms a fallback turn timer so the game cannot silently stall.
3. A reproduction test (written first) that exercises the real socket path — human wins first, remaining AI seats must continue — with a real `turnTimerSeconds`, and asserts the AI seats advance **synchronously without the turn timer firing** and the game reaches `COMPLETED`. This test **fails on current `main`** because the loop bails out mid-completion via B3.
4. Regression coverage for each `autoPlayAbandoned` exit branch (auto-action `null`, `applyAction` throws, divergence guard exhausted) proving a timer is armed (or the loop otherwise makes progress) in every branch.
5. Confirming the last-two-players Big2 completion path: the final AI play cleanly transitions to game-over with no timer-forced default action.

**Explicitly does NOT cover:**

- Any change to the pure engine (`big2-engine.ts`, Tonk engine). `getAutoTimeoutAction` and finish/advance logic are correct and stay untouched (architecture principle 4 — engine has no timer/transport awareness).
- Any change to `TurnTimerService`, `GameService`, `StatsService`, `createGame`, or the DB layer.
- Smart AI / move quality (that is #128).
- The root diagnosis is a turn-**scheduling** defect in the socket layer, not a game-rules defect. Fix stays in the socket layer.

## Approach

### Root cause (confirmed by tracing the code)

Big2 does not end when the first player empties their hand — play continues among the remaining seats to determine placements; the game only completes when `activePlayers.length <= 1` (`big2-engine.ts:287-327`). So after a human's winning play:

1. `handleGameAction` (`socketHandler.ts:510-554`) re-reads state, sees `status === "IN_PROGRESS"` (not `COMPLETED`), and the now-current seat is an AI seat → it takes the auto-play branch (line 544-553): broadcasts, then calls `autoPlayAbandoned`, and **does not arm a turn timer** (the `startTurn` at line 557 is only reached in the non-auto-play branch). Arming is delegated to `autoPlayAbandoned`.
2. `autoPlayAbandoned` (`socketHandler.ts:124-200`) is a bounded loop. The bound is `maxIterations = playerCount * MAX_AUTO_ACTIONS_PER_SEAT` where `MAX_AUTO_ACTIONS_PER_SEAT = 2` (`socketHandler.ts:32,136`). Each loop iteration applies **one** auto-action. The comment frames this cap as "auto-actions to advance **one** seat to the next" — i.e. it was sized for the case where the loop drives the current AI seat forward by a turn or two and then stops at a human. **But after a human finishes first, the loop must instead drive the *remaining N driven seats* through their entire remaining hands** — many plays and passes across multiple tricks — before `activePlayers.length <= 1`. That is `O(cards-remaining)` auto-actions, far more than `playerCount * 2`.

   Concrete trace (1 human + 3 AI, 4 seats, human finishes first): after the human's finishing action, 3 AI seats each still hold ~13 cards and must play/pass across several tricks to determine 2nd/3rd/4th. `maxIterations = 4 * 2 = 8`. The loop applies ~8 auto-actions, is nowhere near completion (still an AI seat current, `status === "IN_PROGRESS"`), and falls out of the `for` into **branch B3** — the divergence guard — which logs a warning and **arms no timer**. The AI seat is left holding the turn.

3. The three exit branches that stop on a still-driven seat (before the happy-path `startTurn` at line 154, which only runs in the `!shouldAutoPlay` branch when `i > 0`):
   - **B1 — `getAutoTimeoutAction` returns `null`** (`:160-161`): `return;` with the driven seat still current and no timer armed.
   - **B2 — `applyAction` throws and is swallowed** (`:163-167`): `return;` with no timer armed.
   - **B3 — divergence guard exhausted** (`:193-199`): falls out of the loop, logs a warning, arms no timer. **This is the branch that fires in the reported bug.**
4. Meanwhile the human's previous turn timer was **never cancelled** on this action (the auto-play branch skips `startTurn`, and B3 does not reach the `COMPLETED` branch's `unregisterGame`). That stale timer is the ~60s the user observed. When it fires, `handleTimerExpired` → `getAutoTimeoutAction` → `{ type: "pass" }` (`big2-engine.ts:186`) produces the "default pass." `handleTimerExpired` then calls `autoPlayAbandoned` again, which **again** blows the `playerCount * 2` guard on the still-many-cards state → "continued to hang" for another timer cycle. Every reported detail (~60s, default pass, continued hang, only in AI games, on the game-ending stretch) matches this exact path.

**Why the primary repro fails on `main` (reconciling with §2 above):** On the *pure happy path with no undersized bound* the loop would reach `activePlayers <= 1`, hit the `COMPLETED` branch (`:170-181`), call `unregisterGame` (cancelling the stale timer) — all synchronously before any timer fires — and the game would complete cleanly. That is exactly why an unbounded driver never sees the bug: the service-layer test's `driveToCompletion` helper (`tests/service/aiSeat.test.ts:114-139`) uses `maxMoves = 2000`, so it *does* reach `COMPLETED` and passed, masking the defect. The production loop's real bound is `playerCount * 2`, which is reached **first**, so on `main` the loop exits via B3 with an AI seat current and no timer — the game does **not** reach `COMPLETED` until `fireAll()` forces the fallback pass, and even then re-hangs. A `FakeTimerProvider` repro that never calls `fireAll()` therefore **fails on `main`** (game stuck `IN_PROGRESS`, an AI seat current, a stale timer pending) and **passes after the fix** (game reaches `COMPLETED` synchronously, `pendingCount === 0`). The earlier inconsistency the reviewer flagged came from describing B1/B2/B3 as "unreachable in normal play"; in fact **B3 is reached on the normal happy path** whenever the number of remaining driven auto-actions exceeds `playerCount * 2`, which is the common case for a mid-game human finish.

### The fix (two parts)

**Part 1 — fix the loop bound so the happy path completes (primary).** The divergence guard must bound *pathological non-progress* (an engine that never advances/completes), **not** the legitimate number of auto-actions needed to finish the game. Replace the per-seat cap with a bound proportional to the maximum total auto-actions a game can require, plus progress detection:

- Size the cap to the game's maximum possible remaining auto-actions rather than `playerCount * 2`. Concretely, bound by total cards in play across all seats plus one pass per seat per trick — a safe, generous upper bound is `players.length * (maxHandSize + players.length)` (for Big2, `maxHandSize <= 13`), which comfortably covers driving all remaining seats to completion while still terminating. The exact constant is an implementation detail; the requirement is: **the bound must be large enough that the happy-path completion is never truncated, and small enough to terminate a genuinely stuck engine.**
- **Detect real non-progress directly** rather than relying solely on a large count: track the `(version)` of the engine state across iterations; if an `applyAction` succeeds but `state.version` does not advance (or `currentPlayerIndex` and `version` are both unchanged after an applied action), that is the true "engine not advancing" condition and is the correct trigger for B3 — independent of hand size. This makes the guard robust for both Big2 and Tonk (Tonk multi-phase turns still advance `version` each phase) and removes the dependence on `MAX_AUTO_ACTIONS_PER_SEAT` for correctness.

  Recommended: keep a generous absolute iteration ceiling (belt) **and** a version-progress check (suspenders). If either the ceiling is hit or a completed `applyAction` fails to advance `version`, treat it as B3.

**Part 2 — arm a fallback timer on every non-progress exit (defense-in-depth).** Even with the corrected bound, no exit that stops on a still-driven seat while `IN_PROGRESS` may leave the game with no pending timer in a **timer-configured** game. The invariant we guarantee:

> **In a timer-configured game, after `autoPlayAbandoned` returns while the game is still `IN_PROGRESS`, either (a) the current seat is a human with the turn timer armed, or (b) the current seat is a driven seat with the turn timer armed as a fallback so the next timer tick will drive it.** There is no exit where a driven seat is current and no timer is pending. *(See "No-timer games" below for the explicitly-scoped exception.)*

Introduce a single helper and call it from all three exit sites (and keep the existing happy-path arm):

```
armFallbackTimer(gameId, turnTimerService):
  if turnTimerService.hasTimer(gameId):
    turnTimerService.startTurn(gameId, false)   // (re)arms a 1x timer, cancelling any stale one
```

- **B1 (`getAutoTimeoutAction` null):** before `return`, call `armFallbackTimer`. With Part 1's fix this is unreachable for a live current seat in Big2 (a current, non-finished seat always has a legal auto-action; a finished seat is never `currentPlayerIndex`) and Tonk (always a draw/discard while `IN_PROGRESS`) — but if it ever occurs we must not silently stall.
- **B2 (`applyAction` throws):** the original comment claims "concurrent action already advanced the turn," but AI/auto actions are single-threaded per game in the socket handler, so a throw here means the engine rejected the auto-action — a real defect, not a benign race. Before `return`, call `armFallbackTimer` so the seat is retried on the next tick instead of hanging. We deliberately do not synchronously loop-retry (that would risk a tight loop if the engine keeps rejecting); the timer gives a bounded, observable retry.
- **B3 (divergence guard exhausted):** replace the current "arm no timer" fail-safe with `armFallbackTimer`. With Part 1, B3 now only fires on genuine engine non-progress; arming a fallback bounds that stall to one timer cycle and routes recovery through the observable `handleTimerExpired` path. Keep the `console.warn` for observability.

Because `startTurn` cancels any existing timer before scheduling (`turnTimerService.ts:37`), `armFallbackTimer` also **clears the stale human timer**.

### No-timer games (scoped limitation)

`armFallbackTimer` is a no-op when `hasTimer(gameId)` is `false`, which is true for any game created with **no** turn timer (`turnTimerSeconds === null`; `turnTimerService.ts:85-88`). The invariant above is therefore **explicitly scoped to timer-configured games.** For no-timer games there is no fallback tick, so a driven seat that hit B1/B2/B3 on `main` would hang permanently. This is why **Part 1 (the loop-bound fix) is the load-bearing fix, not Part 2:** with the corrected bound and version-progress guard, a no-timer game's happy path drives every remaining seat to `COMPLETED` synchronously inside `autoPlayAbandoned` and never reaches B1/B2/B3 in normal play. The residual permanent-hang risk for no-timer games is confined to B1/B2/B3, which after Part 1 fire only on a genuine engine bug (never-advancing or auto-action-rejecting engine) — a defect we surface via `console.warn` and cannot recover from without a scheduling primitive that no-timer games by definition do not have. **Accepted limitation:** in a no-timer game, a genuine engine non-progress bug results in a stalled game with a logged warning rather than a timer-forced recovery; this is acceptable because (a) it requires a separate engine defect to trigger, (b) it is loudly logged, and (c) adding a timer-independent scheduler solely for this case contradicts architecture principle "deploy cheap / keep the timer the single scheduling authority." We do **not** introduce a second scheduling mechanism. This is called out here rather than left implicit.

**Why not also cancel the stale timer in `handleGameAction`'s auto-play branch?** That would be a second mitigation for the *stale-timer* symptom, but it does not address the true root cause (Part 1 — the loop truncating before completion). We do not rely on it: the loop is the correct owner of the driven-seat timer contract, and centralizing the guarantee in `autoPlayAbandoned` covers all callers (`handleGameStart`, `handleGameAction`, `handleTimerExpired`) uniformly. Cancelling in `handleGameAction` alone would leave the game-start-with-AI-first-actor path (no stale timer, but also none armed) able to stall, and would not stop the loop from bailing out mid-completion. The loop-centric fix is complete; the handler-side cancel is not.

### Interaction with the happy path (no regression)

- When `autoPlayAbandoned` reaches a human after driving ≥1 AI seat (`i > 0`), it still calls `startTurn(gameId, false)` (line 154) — unchanged.
- When it reaches a human without driving anyone (`i === 0`, e.g. the caller mis-predicted), it still returns without arming (the caller — `handleGameAction` non-auto branch — owns arming in that case). This path is not a driven-seat exit, so the invariant holds. The three fixed exit sites (B1/B2/B3) are, by construction, reached only while a driven seat is current, so an unconditional `armFallbackTimer` at those three sites is safe; the `!shouldAutoPlay` branch keeps its existing `i > 0` logic untouched.
- **Part 1 does not change the happy-path arm.** Enlarging the loop bound only lets the loop keep making progress; the `!shouldAutoPlay` (human reached) and `COMPLETED` exits are unchanged, so the happy-path timer arm and completion behavior are preserved.
- Human-vs-human games never enter `autoPlayAbandoned` unless a seat is abandoned; for abandoned humans the fallback-timer behavior is an improvement (previously B1/B3 could strand an abandoned seat too). The existing turn-timer integration tests (`turn-timer.test.ts`) for the multi-abandoned Big2 chain must still pass unchanged (they exercise the happy path).

### Completion path (last two players) — verify, no code change expected

When the AI's auto-action empties the second-to-last hand, `handlePlayCards` returns `status: "COMPLETED"` (`big2-engine.ts:293-326`). `autoPlayAbandoned`'s `COMPLETED` branch (`:169-181`) already unregisters the timer, clears abandoned, and broadcasts — no fallback timer is armed (correct, the game is over). The fix must not arm a timer when the loop exits via `COMPLETED`; the three fixed sites are all on the `IN_PROGRESS` branch, so this is preserved. With Part 1, the loop now actually **reaches** this `COMPLETED` branch in the reported scenario instead of bailing via B3 first. A test asserts that after the final AI play the game is `COMPLETED` with `hasTimer(gameId) === false` and no `game:timerExpired` was emitted.

## Interfaces / Types

No public interface changes. One private helper added to `socketHandler.ts`, plus an internal change to the `autoPlayAbandoned` loop bound (Part 1). No signature change to `autoPlayAbandoned` itself.

```ts
/**
 * Arm a 1x turn timer as a fallback when the auto-play loop exits while a
 * driven seat is still current, so the game advances on the next tick rather
 * than stalling. No-op when the game has no timer configured (hasTimer false).
 */
function armFallbackTimer(
  gameId: string,
  turnTimerService: TurnTimerService,
): void;
```

**Loop-bound change (Part 1):** `MAX_AUTO_ACTIONS_PER_SEAT` is replaced/augmented so `autoPlayAbandoned` bounds the loop by (a) a generous absolute ceiling that covers driving all remaining seats to completion (e.g. `players.length * (maxHandSize + players.length)`), and (b) a per-iteration version-progress check: after a successful `applyAction`, if `state.version` does not advance, treat it as divergence (B3). The old `MAX_AUTO_ACTIONS_PER_SEAT = 2` constant is removed or repurposed; the comment claiming it is "auto-actions to advance one seat" is corrected.

**Log shapes (specified so branch tests can assert precisely):**
- **B2** caught error: `console.warn("autoPlayAbandoned: auto-action rejected by engine for game <gameId>; armed fallback timer", err)` — severity `warn`, includes the caught `err`. (Replaces the current silent `catch {}` swallow.)
- **B3** divergence: retain the existing `console.warn` but update its message to reflect that a fallback timer is now armed, e.g. `console.warn("autoPlayAbandoned: divergence guard hit (<n> iterations) for game <gameId>; armed fallback timer")`. Severity `warn`.

Branch tests assert on the `console.warn` spy (severity + that it was called once for the branch), not on the exact string, but the message shape above is the intended implementation.

No new socket events, no new error codes, no `GameService` / `StatsService` / engine signature changes.

## State Model

- **In-memory (`autoPlayAbandoned` loop, Part 1):** the loop now tracks the engine `state.version` (and/or `currentPlayerIndex`) across iterations to detect true non-progress, and uses a completion-sized ceiling instead of `playerCount * 2`. This is transient local loop state only — nothing persisted, no cache mutation beyond what `applyAction` already does.
- **In-memory (`TurnTimerService`):** the only service state touched. On each fixed early-return in a timer-configured game, `startTurn(gameId, false)` (re)arms `activeTimers`/`deadlines` for the game (cancelling any stale handle first). In a no-timer game `armFallbackTimer` is a no-op (`hasTimer` false). No timer is armed on the `COMPLETED` exit (unchanged). `registerGame` config is untouched.
- **In-memory (engine `InternalGameState` / cache):** unchanged. The engine is not modified; `getAutoTimeoutAction`, finish/advance, and completion logic are as-is.
- **Persisted (Supabase):** unchanged. No new writes; the fix only affects in-memory timer scheduling.
- **Broadcast:** on the fallback-timer arm, the subsequent `broadcastGameState` (already called before each early return? — no) is **not** re-issued by the fix; B1/B2/B3 exit without a state change (no action applied), so there is nothing new to broadcast. The pre-existing broadcasts (per successful auto-action, and on completion) are unchanged. The client's `turnDeadline` will refresh on the next broadcast (driven by the fallback timer's `handleTimerExpired`).

## Edge Cases

1. **Human wins first in a 1-human + 3-AI Big2 game (4 seats), human finishes first — the reported bug.** Three AI seats remain and must play out many tricks (well over `playerCount * 2 = 8` auto-actions). On `main` the loop bails via B3 mid-completion, leaving an AI seat current with a stale timer → ~60s hang → forced default pass → re-hang. After the fix, Part 1's completion-sized bound + version-progress guard drives all three AI seats synchronously to `COMPLETED`; no timer fires. (Primary reproduction — fails on `main`, passes after fix.)
2. **Human wins first in a 1-human + 1-AI Big2 game; one AI seat remains → game completes on the AI's next play.** Fewer remaining auto-actions may fit under the old cap, so this variant may not reproduce on `main` — it is a completeness/regression case, not the primary repro. After the fix it reaches `COMPLETED` synchronously with no timer fire.
3. **B1 — `getAutoTimeoutAction` returns `null` mid-loop.** Fallback timer armed (timer-configured games); game advances on next tick via `handleTimerExpired` instead of hanging. After Part 1 this is unreachable for a live seat in Big2/Tonk; the branch test forces it via a mock to prove the arm.
4. **B2 — `applyAction` throws for an auto-action.** Fallback timer armed; bounded retry on next tick; the caught `err` is logged via `console.warn` (see Interfaces "Log shapes"). The existing silent swallow is replaced with arm-then-log-then-return.
5. **B3 — divergence guard exhausted (genuine engine non-progress).** After Part 1, B3 fires only when a successful `applyAction` fails to advance `state.version` (or the absolute ceiling is hit). Fallback timer armed (was: none); `console.warn` retained with updated message. Bounds the stall to one timer cycle.
6. **No-timer game (`turnTimerSeconds === null`) hits B1/B2/B3.** `armFallbackTimer` is a no-op (`hasTimer` false). Explicitly-scoped limitation (see "No-timer games" in Approach): after Part 1 these branches fire only on a genuine engine bug, are loudly logged, and no timer-independent recovery is introduced. Normal no-timer happy-path completion is fully covered by Part 1 (loop drives to `COMPLETED` synchronously).
7. **Human-vs-human game, no AI, no abandonment.** `autoPlayAbandoned` is never entered (the post-action `shouldAutoPlay` check is false). Zero behavior change. (Regression-guarded by existing `turn-timer.test.ts`.)
8. **Abandoned-human auto-play (pre-existing feature).** B1/B3 previously could strand an abandoned seat; now (timer-configured games) they arm a fallback, and Part 1 prevents premature B3. Existing multi-abandoned-chain integration test still passes (happy path unchanged).
9. **Completion inside the loop.** No fallback timer armed (the `COMPLETED` branch returns before any fixed site). Verified by test asserting `hasTimer === false` post-completion.
10. **Game start with an AI first-actor (LLD 118 path).** `handleGameStart` → `autoPlayAbandoned` with no stale timer. If it drives to a human, happy-path arm fires (unchanged). If it hits B1/B2/B3 in a timer-configured game, fallback arm fires. Covered by the branch tests.

## Dependencies

- **Must exist (all present):** `autoPlayAbandoned` and its `MAX_AUTO_ACTIONS_PER_SEAT` bound (`socketHandler.ts:32,136` — modified by Part 1), `handleGameAction`, `handleGameStart`, `handleTimerExpired` (`socketHandler.ts`); engine `InternalGameState.version` (used by the version-progress guard); `TurnTimerService.startTurn` / `hasTimer` / `unregisterGame` (`turnTimerService.ts`); `getAutoTimeoutAction` and finish/advance logic (`big2-engine.ts`); `GameService.isAiSeat` / `getAiSeatIds` (LLD 118); `createGame` `numAiSeats` route support (LLD 120); `FakeTimerProvider.fireAll` / `pendingCount` and `TestServerContext` (`tests/integration/helpers/testServer.ts`).
- **No new migration, no schema change, no new dependency.**
- **Blocks nothing;** this is a leaf bug fix on shipped code.

## Test Requirements

Follow testing-principles: self-contained, deterministic (`FakeTimerProvider` — no wall-clock waits), invariant checks, integration smoke to `COMPLETED`. Write the **reproduction test first** (must fail on current `main`, pass after the fix). Tests are automated; no manual table.

### Integration — reproduction (write first; `tests/integration/`, new file e.g. `ai-completion.test.ts`)
- **Repro (primary AC):** Create a Big2 game via the real route with `turnTimerSeconds: 30` and enough AI seats that the remaining driven auto-actions after the human finishes **exceed `playerCount * MAX_AUTO_ACTIONS_PER_SEAT`** — use `numAiSeats: 3`, `maxPlayers: 4` (this is the reported configuration and the one that deterministically reproduces on `main`). Connect the human socket, `game:start`, then drive the human's real actions (play from `validActions`) until the human empties their hand and finishes first while `status` stays `IN_PROGRESS`. Assert:
  - (a) After the human's finishing action, remaining AI seats advance **synchronously**: the game reaches `COMPLETED` within the action's `game:state`/ack cycle **without calling `timerProvider.fireAll()`** (the turn timer must never fire). Assert `timerProvider.pendingCount === 0` after completion and that **no `game:timerExpired` event** was received on the human socket.
  - (b) Final `game:state` has `status === "COMPLETED"`, a `winner`, and non-null `scores`.
  - (c) `ctx.turnTimerService.hasTimer(gameId) === false` and `getDeadline(gameId) === null` after completion.
  - **Why this fails on `main`:** with `playerCount * 2 = 8`, `autoPlayAbandoned` runs out of iterations while 3 AI seats still hold cards, exits via B3 with an AI seat current and a stale timer pending. Without `fireAll()` the game is stuck `IN_PROGRESS` (assertion (b) fails) and `pendingCount === 1` (assertion (a) fails). After the fix the loop's completion-sized bound drives to `COMPLETED` synchronously and all three assertions hold. **This must be verified red-on-main / green-after-fix before implementation is accepted.**
- **Last-two-players completion (AC "confirm last-two path"):** In the same test, assert the transition to `COMPLETED` happens on an AI play (not on a timer-forced action) — record the sequence of `game:timerExpired` events across the whole game and assert it is empty.

### Integration / socket-layer — exit-branch regression (`tests/websocket/socketHandler.test.ts`, extend the existing AI describe block; use the existing mock-`GameService` harness where `hasTimer` mock → `true`)
For each branch, construct a state where the current seat is an AI seat in a timer-configured game and assert `turnTimerService.startTurn(gameId, false)` **is called** (fallback armed) — i.e. no branch leaves a driven seat with no timer. Use a `console.warn` spy where noted.
- **B1:** `getGameState` returns an `IN_PROGRESS` state on an AI seat; mock the engine (or state) so `getAutoTimeoutAction` yields `null`. Assert `startTurn(gameId, false)` was called before the loop returned.
- **B2:** `applyAction` rejects (throws) on the AI seat's auto-action. Assert (i) `startTurn(gameId, false)` was called, (ii) the throw is **not** rethrown (the handler ack still resolves `success: true`), and (iii) `console.warn` was called once with the caught error (assert on the spy: called with `warn` severity and the error as an argument; do not assert the exact message string).
- **B3:** force divergence by making every `applyAction` **succeed but not advance** — the state mock must keep `status === "IN_PROGRESS"` **and** keep returning the **same** AI seat as `currentPlayerIndex` **and not advance `state.version`** on every read, for all iterations. This guarantees the loop exits specifically via the version-progress / ceiling divergence guard (B3) and not via the `status !== "IN_PROGRESS"` early exit at `socketHandler.ts:140` or a human-seat exit — otherwise the test would exercise a different path and be mislabeled. Assert the loop exits, `console.warn` was called once (B3 message, `warn` severity), **and** `startTurn(gameId, false)` was called (was: never armed).
- **Happy-path regression:** AI seat drives to a human seat → `startTurn(gameId, false)` called exactly once at the human (unchanged); reaching `COMPLETED` → `startTurn` **not** called and `unregisterGame` called.

### Integration — no regression to existing timer/abandonment behavior
- Existing `turn-timer.test.ts` suites (human-vs-human deadlines, single-phase auto-timeout, multi-abandoned chain) must pass unchanged — no new assertions required; run them as the regression gate for the timer contract.
- **Loop-bound regression:** confirm the service-layer `driveToCompletion`-style completion (previously masking the bug) still reaches `COMPLETED` — i.e. Part 1's bound never truncates a legitimate multi-seat play-out.
</content>
</invoke>
