# LLD 98: Tonk multi-phase turn-timer re-arm — drive auto-discard AND auto-draw without stalling (backend-only)

## Scope

**Covers (backend only):** proving and, where needed, fixing that the turn-timer / auto-timeout infrastructure in `socketHandler.ts` drives **both** phases of a Tonk turn (discard then draw) for the same seat without stalling.

- `handleTimerExpired` path: a connected-but-AFK Tonk player who times out in `turnPhase === "discard"` gets the timer re-armed for the **same seat**, and auto-draws on the next timer fire — the turn completes and the game does not stall. (This path is suspected to already work; the work is to **confirm with a test** and fix only if the test reveals a stall.)
- `autoPlayAbandoned` path: multiple consecutive **abandoned** Tonk seats are fully auto-played through **both** phases, and the timer is correctly armed for the first connected seat reached (or the game ends). The loop bound is the suspected defect.
- A re-arm / loop-bound fix that is **game-agnostic** — driven entirely off the engine's per-phase `getAutoTimeoutAction` and the engine's own `currentPlayerIndex` advancement. No Tonk literals in the WebSocket layer or timer service.
- Big2 (single-phase) auto-timeout behavior is a regression guard and must be unchanged.

**Explicitly does NOT cover:**

- Any UI, browser E2E, spectate/reconnect/join-by-code verification — that tail stays in #105, blocked by #59 (Tonk player actions UI).
- Tonk action UI (#59) in any form.
- Changes to the Tonk engine's rules, `getAutoTimeoutAction` choice logic, or scoring. The engine's per-phase auto-action is treated as a fixed dependency.
- The `TurnTimerService` / `FakeTimerProvider` internals (no API change needed there).

## Approach

### Key decisions

1. **Loop-bound fix is generic, derived from phases-per-turn, not hard-coded to Tonk.**
   The defect (see Edge Cases E1) is that `autoPlayAbandoned`'s `maxIterations = state.players.length` assumes **one** auto-action advances the turn to the next seat. Tonk consumes up to two auto-actions per seat (discard, then draw) before `currentPlayerIndex` moves. The fix must not encode "2" as a Tonk constant. Two candidate approaches:

   - **(A) Bound by observed progress, not iteration count.** Replace the fixed `players.length` cap with a loop that terminates on a *semantic* condition — reaching a non-abandoned current seat, game completion, or `getAutoTimeoutAction` returning `null` — and uses a generous safety cap to prevent a true infinite loop. The safety cap is computed generically as `players.length * MAX_PHASES_PER_TURN` where `MAX_PHASES_PER_TURN` is a small constant upper bound on auto-actions any engine takes to advance one seat (currently 2: discard→draw). This is a *safety net*, not a correctness driver — correctness comes from the semantic exit conditions.
   - **(B) Detect seat advancement explicitly.** Track `currentPlayerIndex` across iterations; only count a "player processed" when the index actually changes (or the game completes). Bound the number of *seats* processed by `players.length`, but allow multiple iterations per seat. Still needs an absolute safety cap on total iterations.

   **Recommended: (A)** with the loop's *primary* exit being the existing semantic checks (non-abandoned seat reached → re-arm timer and return; completion → unregister and return; `null` auto-action → return). The iteration counter becomes purely a divergence guard sized as `players.length * MAX_PHASES_PER_TURN`. Rationale: (A) is the smallest change to the current structure, keeps the existing "reached a connected player → `startTurn`" re-arm logic intact, and the only new concept is widening the safety cap. It does not require the WS layer to reason about "did the seat change," which (B) does and which couples the loop to engine turn semantics more tightly.

2. **Re-arm on loop exhaustion must not silently stall.**
   In the current code, if the `for` loop runs out of iterations it falls through with **no `startTurn` call** (the re-arm only fires inside the early-return branch). After the bound fix this should not happen for well-formed engines, but the fix must guarantee that **whenever the loop stops on a non-abandoned current seat, the timer is armed** — i.e. the re-arm decision is based on the *current state's seat*, not on whether the loop ended early. The recommended structure keeps re-arm inside the "reached non-abandoned seat" branch (the only branch that ends on a seat that still needs a human/timer), so exhaustion of the safety cap (a divergence bug) does not arm a timer on an abandoned seat — it logs and returns, matching today's fail-safe posture.

3. **`MAX_PHASES_PER_TURN` lives as a single named constant in the WebSocket layer**, documented as "max auto-actions any engine needs to advance one seat." It is engine-agnostic: Big2 = 1, Tonk = 2, both ≤ 2. This is the one number that must change if a future engine needs 3 phases; it is **not** branched on `gameType`. Flag for the design reviewer: if this constant feels like a leak (the WS layer "knowing" about phases), the alternative is approach (B), which derives advancement purely by observing `currentPlayerIndex` and needs no phase constant at all — call this out and let the reviewer pick.

### Abstraction-leak finding (flagged, see Dependencies / Escalation)

`TimerExpiredPayload.action` is typed `"pass" | "playCards"` (Big2 vocabulary) and `handleTimerExpired` casts the auto-action type to it:
`action: autoAction.type as "pass" | "playCards"`.
For Tonk the auto-action type is `"discard"` or `"draw"`, so this cast **misrepresents the emitted event** for Tonk. This is a pre-existing leak of Big2 action names into the shared transport type. It does not cause a stall (the payload is informational), so it is **out of strict scope** for the stall fix, but it violates the "no game-specific vocabulary in the WS/transport layer" principle. **Recommendation:** widen `TimerExpiredPayload.action` to `string` (or `GameAction["type"]`) and drop the cast. Marked optional within this LLD; if the design reviewer agrees it is in-scope as part of "keep the fix game-agnostic," the implementer should include it. No browser depends on the `action` field's narrow type today.

## Interfaces / Types

No new public interfaces. Internal change confined to `src/backend/websocket/socketHandler.ts`.

```ts
// socketHandler.ts — module-level constant (new)
/**
 * Upper bound on auto-timeout actions any engine takes to advance one seat to
 * the next. Big2 = 1 (pass/playCards advances immediately). Tonk = 2
 * (discard then draw advance the same seat through two phases before the
 * seat changes). Used only as a divergence guard for autoPlayAbandoned —
 * loop correctness comes from the semantic exit conditions, not this number.
 */
const MAX_AUTO_ACTIONS_PER_SEAT = 2;
```

`autoPlayAbandoned` signature is unchanged:

```ts
async function autoPlayAbandoned(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): Promise<void>
```

Behavior change (recommended approach A):

```
maxIterations = (players.length) * MAX_AUTO_ACTIONS_PER_SEAT   // was: players.length
```

Loop body and exit conditions otherwise unchanged:
- current seat not abandoned → if any auto-action was applied (`i > 0`), `startTurn(gameId, false)`; return.
- `getAutoTimeoutAction` returns `null` → return (no arm).
- applyAction throws → return (concurrent action already advanced + armed).
- newState COMPLETED → unregister, clear abandoned, broadcast, return.
- otherwise broadcast and continue.

Optional (if leak fix accepted):

```ts
// socket-events.ts
export interface TimerExpiredPayload {
  gameId: string;
  playerId: string;
  action: string; // was: "pass" | "playCards" — widened to cover Tonk discard/draw
}
```
and in `handleTimerExpired`, drop the `as "pass" | "playCards"` cast.

## State Model

No new persisted or in-memory state. All state already exists:

- **Engine state (`InternalGameState`, in-memory cache + DB):** `currentPlayerIndex`, `gameSpecificState.turnPhase` (Tonk). The engine alone owns phase progression: an auto-`discard` leaves `currentPlayerIndex` unchanged and flips `turnPhase` to `"draw"`; an auto-`draw` advances `currentPlayerIndex` via `nextSeat`. The WS layer never reads `turnPhase` — it only re-invokes `getAutoTimeoutAction(currentState)` each loop iteration and lets the engine decide the per-phase action.
- **Abandoned set (`ConnectionManager.abandonedPlayers`, in-memory):** unchanged. `handleTimerExpired` marks a disconnected timed-out player abandoned; `autoPlayAbandoned` reads `isAbandoned` per iteration.
- **Timer (`TurnTimerService`, in-memory):** unchanged API. Re-arm is `startTurn(gameId, false)`; cancellation/unregister on completion is unchanged.

**Flow — `handleTimerExpired` for a connected AFK Tonk player (no stall expected):**
1. Timer fires → `getAutoTimeoutAction` returns `discard` (phase=discard) → applyAction → state now same seat, phase=draw.
2. Player is connected → not marked abandoned → next seat is the **same** (current) seat, which is not abandoned → `startTurn(gameId, false)` re-arms (line 626 branch). Broadcast. `autoPlayAbandoned` no-ops (current seat not abandoned).
3. Next timer fire → `getAutoTimeoutAction` returns `draw` (phase=draw) → applyAction → seat advances. Re-arm for the new seat. Turn completed across two fires.

**Flow — `autoPlayAbandoned` for multiple abandoned Tonk seats (the fix):**
- Entered after an action/timeout leaves an abandoned seat current. Each iteration applies one per-phase auto-action. A single abandoned Tonk seat takes 2 iterations (discard, draw) to advance; M consecutive abandoned seats take up to `2*M` iterations. With the widened cap `players.length * 2`, the loop reaches the first connected seat (or completion) before exhausting iterations, and arms the timer for that connected seat.

## Edge Cases

- **E1 (the bug): multiple abandoned Tonk seats exhaust the old `players.length` cap mid-turn.**
  With the old bound, M abandoned Tonk seats need up to `2*M` iterations but the loop caps at `players.length`. The loop exits by exhausting iterations on an **abandoned** seat **without calling `startTurn`** → permanent stall (no timer, no human). **Handling:** widen cap to `players.length * MAX_AUTO_ACTIONS_PER_SEAT`; primary exit remains the semantic "reached non-abandoned seat → arm timer" branch.

- **E2: abandoned seat times out mid-turn (discard done, draw pending), entered via `handleTimerExpired`.**
  `handleTimerExpired` applies the discard, marks the seat abandoned (disconnected), then the "next player" is the **same abandoned seat** (phase=draw) → it skips `startTurn` (line 624 branch) and calls `autoPlayAbandoned`, which must complete the draw and continue. **Handling:** covered by the same widened loop; the first loop iteration is the pending `draw`.

- **E3: all remaining seats abandoned, game completes mid-loop (Tonk trick/match end on a `draw` or stock-out).**
  An auto-`draw` can trigger `endTrick`/`completeMatch` → status COMPLETED. **Handling:** existing COMPLETED branch unregisters the timer, clears abandoned, broadcasts, returns. No timer left armed. Must be asserted.

- **E4: `getAutoTimeoutAction` returns `null` mid-loop** (e.g. empty hand in discard phase). **Handling:** existing `if (!autoAction) return;` — loop exits without arming. Acceptable fail-safe; assert it does not throw. (Not expected in normal Tonk flow; documented so the implementer does not "fix" it into a stall.)

- **E5: concurrent player action during the loop** (a player reconnects and acts, or the per-fire `applyAction` races). **Handling:** existing `try/catch` around `applyAction` returns silently; the concurrent action's own handler armed the timer. Unchanged.

- **E6: Big2 single-phase regression.** Big2 advances the seat in one auto-action; with the widened cap the loop simply reaches a non-abandoned seat (or completion) in ≤ `players.length` effective iterations and arms exactly as before. **Handling:** the widened cap is a strict superset of the old behavior for single-phase engines; assert Big2 timeout flow is byte-for-byte equivalent in observable behavior (one auto-action per fire, timer re-armed, same events).

- **E7: divergence guard hit (safety cap exhausted).** Only reachable if an engine never advances/completes (a bug). **Handling:** loop falls through without arming a timer (today's posture); add a `console.warn` so this is observable rather than silent. Not arming on a still-abandoned seat is the correct fail-safe (don't pin a timer on a dead seat).

## Dependencies

**Must exist before implementation (all present in `main`):**

- `TonkEngine.getAutoTimeoutAction` returning per-phase `discard`/`draw` — `src/backend/engine/tonk/tonk-engine.ts:206`.
- `handleTimerExpired` and `autoPlayAbandoned` — `src/backend/websocket/socketHandler.ts:577`, `:79`.
- `TurnTimerService.startTurn` / `getDeadline` / `hasTimer` / `unregisterGame` and `FakeTimerProvider.fire`/`fireAll`/`pendingCount`/`lastScheduledId` — `src/backend/timer/`.
- `ConnectionManager.markAbandoned`/`isAbandoned`/`clearAbandoned` — `src/backend/websocket/connectionManager.ts`.
- Integration harness `createTestServer` (exposes `timerProvider`, `turnTimerService`, `connectionManager`, `gameService`, `gameCache`) — `tests/integration/helpers/testServer.ts`.
- Test-only seed endpoint `POST /test/seed-state` (NODE_ENV=test) for direct state manipulation — `src/backend/api/test/seedState.ts`. Use this to construct a Tonk game already IN_PROGRESS at a chosen `turnPhase`/`currentPlayerIndex` with abandoned seats, per the "direct state manipulation over replay" testing principle, rather than playing a real Tonk game (no Tonk action UI / client flow exists yet).

**Blocks / depends-on (out of scope):**

- #59 (Tonk player actions UI) — the browser/spectate/reconnect tail in #105 depends on it. **Not** a dependency of this backend-only LLD.

**Escalation:** the `TimerExpiredPayload.action` type leak (Big2 vocabulary in a shared transport type) — see Approach §"Abstraction-leak finding". Flagged for the design reviewer to decide whether the widening fix is in-scope here or split out.

## Test Requirements

All tests are backend integration tests using `createTestServer` + `FakeTimerProvider` (deterministic, no browser, no Tonk UI). Use `POST /test/seed-state` to set up Tonk preconditions directly. Each test is self-contained (no shared mutable game state).

### Integration — Tonk re-arm across phases (`handleTimerExpired` path)

- **T1 (AC1): connected AFK Tonk player auto-discards then auto-draws across two timer fires; turn does not stall.**
  Seed a 3-player Tonk game IN_PROGRESS, timer configured, current seat connected, `turnPhase = "discard"`. Fire the timer once → assert an auto-`discard` applied (engine state: that seat's hand shrank by one, `turnPhase` now `"draw"`, `currentPlayerIndex` unchanged) **and** a new timer is pending (re-armed for the same seat; assert `pendingCount`/`getDeadline` non-null). Fire again → assert auto-`draw` applied (`currentPlayerIndex` advanced via `nextSeat`) and timer re-armed for the next seat. Assert the game is not stalled (deadline set, status IN_PROGRESS).

- **T2: invariant — a single Tonk seat never advances on the discard fire.** Within T1 (or a dedicated assertion), confirm the first fire leaves `currentPlayerIndex` unchanged (the discard does not skip the draw). Guards against a regression where the WS layer advances the seat prematurely.

### Integration — multiple abandoned Tonk seats (`autoPlayAbandoned` path)

- **T3 (AC2): N consecutive abandoned Tonk seats are fully auto-played through both phases; timer armed for the first connected seat.**
  Seed a 4-player Tonk game IN_PROGRESS with seats 0,1,2 disconnected+abandoned and seat 3 connected; current seat = 0, `turnPhase = "discard"`. Trigger the auto-play path (fire the timer for seat 0, which marks/handles it and enters `autoPlayAbandoned`, OR invoke the same entry the production code uses). Assert: after the loop settles, `currentPlayerIndex === 3` (or the game COMPLETED), every abandoned seat went through discard **and** draw (assert via engine state / log entries — each abandoned seat produced a `discard` then a `draw` log entry), and the timer is **armed** for seat 3 (`getDeadline(gameId)` non-null, exactly one pending timer). **This test must FAIL against the current `players.length` bound** (loop exhausts on an abandoned seat with no timer armed) and PASS after the fix — call this out so the implementer confirms the red→green.

- **T4 (AC2, completion variant / E3): abandoned seats play through to game completion.**
  Seed a near-end Tonk trick (e.g. stock nearly empty, or seed `tonkGateOpen` such that an auto-action ends the match) with all relevant seats abandoned. Fire/trigger auto-play → assert status reaches COMPLETED, the timer is unregistered (`turnTimerService.hasTimer(gameId) === false`, `getDeadline === null`), and abandoned state is cleared. No pending timer for the game remains.

### Integration — Big2 regression guard

- **T5 (AC3): Big2 single-phase auto-timeout unchanged.**
  Keep/extend the existing `turn-timer.test.ts` Big2 coverage and add an explicit assertion: a single timer fire on Big2 applies exactly one auto-action, advances the seat, and re-arms exactly one timer (`pendingCount` net unchanged, deadline ~1x). A multi-abandoned-Big2 scenario (e.g. 4-player Big2, 3 abandoned) must auto-play one action per seat and arm the timer for the connected seat — confirming the widened cap did not change single-phase behavior.

### Invariant assertions (apply within the above where cheap)

- Total cards conserved across each auto-action (Tonk: hands + stock + discardPile constant). Catches off-by-one in discard/draw.
- Current seat is always a valid player index while IN_PROGRESS; `-1` only when COMPLETED.
- After the auto-play loop settles on an IN_PROGRESS state, the current seat is **not** abandoned **and** a timer is armed (no "stalled on abandoned seat" state). This is the core anti-stall invariant.
- No game-type literal (`"tonk"`, `"discard"`, `"draw"`) is read or branched on in `socketHandler.ts`'s timeout/auto-play code (AC4) — enforce by code review, not a runtime test.

### Out of scope for tests (stays in #105)

- Any browser/Playwright E2E, spectator-view-during-timeout, reconnect-clears-abandoned-mid-Tonk-turn UI verification, join-by-code. These require #59 and are explicitly excluded.
