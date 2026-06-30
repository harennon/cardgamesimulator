# LLD 100: Verify Tonk Two-Phase Turn-Timer Re-arm and Play a Full Tonk Game End-to-End (Spectate + Reconnect)

Parent issue: #60 · Order 4 of 4 · Effort: medium

## Scope

This is a **verification / QA-flavored** LLD, not new feature work. The Tonk consumer chain is already merged on `origin/main`: board (#106), actions UI (#114), Create Game + lobby (#111), `deckRoundsTarget` migration 009 (#110), loss-centric stats (#108). The hard backend requirement — per-phase turn-timer re-arm — was already implemented and integration-tested by **LLD 98 / PR #113** (`MAX_AUTO_ACTIONS_PER_SEAT = 2`, the widened `autoPlayAbandoned` loop bound, and `tests/integration/tonk-timer-rearm.test.ts`).

### In scope

1. **Verify** the existing turn-timer infrastructure auto-acts across BOTH phases of a Tonk turn (auto-discard in phase 1, then auto-draw in phase 2 for the SAME seat) without stalling — end-to-end, in the browser. Close a gap only if one is actually observed.
2. **Play a full Tonk game start-to-finish in the browser**: create → configure player count (3–8) and `deckRoundsTarget` (5–12) → lobby → start/deal → discard / draw / callTonk → match end at `LOSE_THRESHOLD` (150) → game over → loss-centric stats recorded.
3. **Confirm spectating** an in-progress Tonk game works (SpectatorView, no hands, live updates).
4. **Confirm reconnection** into an in-progress Tonk game restores correct per-player state (own hand, phase, deadline).
5. **Confirm join-by-code** resolves and joins a Tonk game.
6. Add the missing **browser-level (Playwright) e2e coverage** for the above as the primary deliverable.

### Explicitly NOT in scope

- Re-architecting the timer service or WebSocket layer. The re-arm fix already exists and is game-agnostic; this LLD only verifies it.
- Any Tonk special-casing inside `TurnTimerService` or `socketHandler` (DO NOT). If an abstraction leaks during verification, **flag it** (escalate to architect), do not patch it inline.
- New migrations (none involved) — the migration-safety harness is out of scope.
- Changing Big2 timer behavior. Big2 = 1 auto-action/seat; Tonk = 2. Any change must preserve Big2.
- Re-testing engine rules already covered by the unit suite (`tests/engine/tonk/*`) or the WS re-arm already covered by `tests/integration/tonk-timer-rearm.test.ts`. Reference them; do not duplicate.

## Approach

### Key decisions and rationale

1. **Verification-first, fix-only-if-broken.** The re-arm mechanism is implemented and integration-tested. The deliverable is *evidence* (a browser e2e that plays a full Tonk game and exercises a timed-out two-phase turn) plus spectate / reconnect / join-by-code coverage. Route the actual run through the **qa** agent against `docs/customer-experience.md`. If a concrete defect surfaces, **delegate the fix to the implementer**, then re-verify — do not fix inline.

2. **The re-arm contract is already correct — confirm, don't change.** Two production loops drive a timed-out Tonk turn through both phases for the same seat:
   - `handleTimerExpired` (socketHandler.ts) applies one `getAutoTimeoutAction` (the phase-1 discard), then re-arms via `turnTimerService.startTurn(gameId, false)` because the engine left `currentPlayerIndex` unchanged and `turnPhase = "draw"`. The next timer fire auto-draws and the seat advances. This is the **connected-but-AFK** path.
   - `autoPlayAbandoned` (socketHandler.ts) loops up to `players.length * MAX_AUTO_ACTIONS_PER_SEAT` (= `players.length * 2`) iterations so a chain of abandoned seats is driven through *both* phases each before reaching a connected seat. This is the **disconnected/abandoned** path.
   Loop correctness comes from the semantic exit conditions (connected seat reached, or `COMPLETED`), not the numeric cap; the cap is a divergence guard only. Both paths are already green in `tonk-timer-rearm.test.ts` (T1/T2 connected-AFK, T3 abandoned-chain, T4 completion).

3. **`MAX_AUTO_ACTIONS_PER_SEAT` is game-agnostic, not Tonk special-casing.** It is a generic per-seat upper bound on auto-actions (Big2 = 1, Tonk = 2), documented as a divergence guard. The engine's `getAutoTimeoutAction` (tonk-engine.ts:206) is the only place that knows Tonk's two phases: it returns a `draw` from stock when `turnPhase === "draw"`, else a single-highest-card `discard`. The timer service and socket handler stay generic. This satisfies the DO-NOT constraint and is the correct abstraction boundary (architecture-principles §4, §9).

4. **Browser e2e drives real UI, not injected sockets.** Per the guest-E2E memory and the existing `tonk-create-lobby.spec.ts` pattern, the new spec creates/joins via the real create-game UI and REST helpers (`createGameViaApi` / `joinGameViaApi` in `e2e/helpers/game-helpers.ts`) and acts through the rendered `TonkActionPanel` (`data-testid="tonk-discard-btn"`, `tonk-draw-stock-btn`, `tonk-take-discard-btn`, `tonk-call-tonk-btn`) and `TonkHand` (`data-testid="tonk-hand"`, per-card click toggles). No manual cookie/socket injection.

5. **Determinism via direct state seeding, not 150-point replay.** Driving a real match to `LOSE_THRESHOLD = 150` through the UI would take dozens of tricks. Per testing-principles §4 (direct state manipulation over replay), use the existing `POST /test/seed-state` endpoint (`e2e/helpers/seed-helpers.ts`) to set up:
   - a near-threshold tally so a single browser-driven trick completes the match (game-over + stats path), and
   - a discard-phase precondition with a short `turnTimerSeconds` so the browser observes a real timed-out two-phase turn.
   Seeding writes both cache and DB and preserves `players` / `randomSeed`, matching how `tonk-timer-rearm.test.ts` and `seed-helpers.ts` already operate.

6. **Reuse the configured Playwright timer length, not fake timers, in the browser.** Browser e2e cannot inject a `FakeTimerProvider` (that is server-internal). Instead create the Tonk game with a real short `turnTimerSeconds` (the existing helper uses 30; the timeout spec may seed/configure a shorter value if the backend exposes one, otherwise wait for the configured duration with a generous Playwright timeout). The deterministic two-phase re-arm assertion at the unit/integration tier remains `tonk-timer-rearm.test.ts` with the `FakeTimerProvider`; the browser test is the *integration smoke* that the same behavior surfaces through the real socket + UI.

7. **Run headless locally before pushing.** CI is headless; per the run-E2E-locally memory, the new spec must pass `npx playwright test` headless on the dev machine before merge.

### What gets built

- One new Playwright spec, `e2e/tonk-full-game.spec.ts` (full play-through, game-over, stats), plus spectate / reconnect / join-by-code cases (may live in the same file or extend `e2e/tonk-create-lobby.spec.ts`; keep create/lobby concerns in the existing file).
- One new Playwright spec, `e2e/tonk-turn-timeout.spec.ts` (or a case in `tonk-full-game.spec.ts`): a Tonk turn left to time out auto-discards AND auto-draws within the same turn, and the turn does not stall (board advances to the next seat).
- A small Tonk seed helper in `e2e/helpers/seed-helpers.ts` mirroring `seedCompletedGame`, but producing a valid `TonkState` (the current helper hardcodes a Big2 `gameSpecificState`).
- No backend/source changes expected. If verification reveals a defect, that fix is a separate implementer task against the relevant LLD (98 for timer, 65/69 for engine), not this LLD.

## Interfaces / Types

No new production interfaces. Verification leans on existing contracts:

```typescript
// src/backend/engine/game-engine.ts — UNCHANGED, relied upon
getAutoTimeoutAction(state: InternalGameState): GameAction | null;
// Tonk impl (tonk-engine.ts:206): turnPhase === "draw" -> { type: "draw", source: "stock" }
//                                  else -> { type: "discard", cards: [singleHighest] }

// src/backend/websocket/socketHandler.ts — UNCHANGED, relied upon
const MAX_AUTO_ACTIONS_PER_SEAT = 2; // generic per-seat cap (Big2=1, Tonk=2)
// autoPlayAbandoned: maxIterations = players.length * MAX_AUTO_ACTIONS_PER_SEAT
// handleTimerExpired: re-arms startTurn(gameId, false) when nextPlayer is connected & game IN_PROGRESS
```

New test-only helper (additive, test infrastructure):

```typescript
// e2e/helpers/seed-helpers.ts — NEW helper
export async function seedTonkState(
  request: APIRequestContext,
  options: {
    gameId: string;
    players: Array<{ id: string; displayName: string }>;
    currentPlayerIndex: number;
    tonk: TonkState;          // from src/backend/engine/tonk/tonk-types.ts
    turnTimerSeconds?: number; // optional db override
  },
): Promise<void>;
```

It posts to `POST /test/seed-state` with `state.gameType = "tonk"`, `state.gameSpecificState = tonk`, `state.status = "IN_PROGRESS"`, the provided `currentPlayerIndex`, and `dbFields` for player roster/timer — exactly the shape `seedTonkState` in `tonk-timer-rearm.test.ts` uses.

## State Model

No new persisted or in-memory state. Verification observes the existing flow (LLD 7a §4, LLD 65 §4):

```
Full-game browser flow (state ownership unchanged):
  Create (REST)        -> games row: gameType=tonk, maxPlayers, game_config.deckRoundsTarget, turnTimerSeconds
  Lobby (WS)           -> lobby:state / lobby:playerJoined; Start gated at >=3 players
  Start (WS)           -> engine.initialize -> InternalGameState (cache + DB); timer registered + startTurn(first=true)
  Play (WS)            -> game:action {discard|draw|callTonk}; engine applies; startTurn(false) re-arms each turn
  Match end            -> scoreTrick/resolveMatchEnd at LOSE_THRESHOLD -> status COMPLETED, scores (loss-centric)
  Game over            -> game:state with winner+scores; timer unregistered; stats written (game-specific, LLD 66)

Timed-out two-phase turn (the hard requirement, already implemented):
  timer fires -> handleTimerExpired -> getAutoTimeoutAction => discard (phase 1)
              -> applyAction (seat unchanged, turnPhase: discard->draw)
              -> startTurn(false)  RE-ARM for the same seat
  timer fires -> handleTimerExpired -> getAutoTimeoutAction => draw (phase 2)
              -> applyAction (seat advances via nextSeat, turnPhase->discard)
              -> startTurn(false) for the next seat   [NO STALL]
```

Persisted vs in-memory is identical to LLD 7a: timer state (deadline, handle) is in-memory only; `turnTimerSeconds` and `game_config.deckRoundsTarget` persist on the games row. Spectator/reconnect views are derived per-request from cache (rehydrated from DB on connect) — no new persistence.

## Edge Cases

| # | Case | Expected handling (verify; do not re-implement) |
|---|------|-------------------------------------------------|
| 1 | Tonk turn fully times out (both phases) | Phase 1 auto-discards (single highest card), seat stays, `turnPhase: draw`; phase 2 auto-draws from stock, seat advances. No stall. (tonk-engine.ts:206; handleTimerExpired re-arm.) |
| 2 | Auto-discard would empty the hand | `getAutoTimeoutAction` returns `null` when `hand.length === 0` in discard phase; loop stops (no action). Verify the timed-out path never produces an illegal discard. |
| 3 | Auto-draw hits empty stock (draw phase) | `handleDraw` detects empty stock and ends the trick (Case C, §5.1/§7), rather than drawing. Match may complete. Verify no stall / no exception. |
| 4 | Player submits a real action just as the timer fires | Engine rejects the loser of the race ("Not your turn" / wrong phase); the winner's handler already re-armed. (LLD 7a E1/E11.) Browser need not force this; integration tier covers it. |
| 5 | Reconnect mid-turn during the draw phase | `handleGameJoin` IN_PROGRESS path re-sends `game:state` with `turnDeadline`, current `turnPhase`, and the player's own hand; abandoned cleared. Verify the reconnecting browser shows draw-phase controls, not discard. |
| 6 | Reconnect after server lost the in-memory timer | `handleGameJoin` timer-recovery branch (`getDeadline === null && !hasTimer`) re-registers and treats the missed turn as expired. Verify the game does not freeze on reconnect. |
| 7 | Spectator joins an in-progress Tonk game | `getSpectatorView` returns counts/piles/tallies/log, **no hands**; `game:spectatorState` carries `turnDeadline`. Verify no hand data in the spectator payload (information-hiding). |
| 8 | Spectator tries to act | `SPECTATOR_CANNOT_ACT` rejected at socket layer. Verify the spectator UI offers no action controls. |
| 9 | Join-by-code for a CREATED Tonk game | Code resolves to gameId, joins lobby. For an IN_PROGRESS game, the join flow offers spectate (CX §"Game already in progress"). Verify the resolved game is the Tonk game (badge shows Tonk). |
| 10 | Match completes mid auto-play chain (all abandoned) | Timer unregistered, abandoned cleared, final `game:state`/`game:spectatorState` broadcast. (Already T4 in tonk-timer-rearm.test.ts; verify the browser game-over screen renders for a normally-played completion.) |
| 11 | Game over → stats | Loss-centric Tonk stats recorded per (user, game_type) (LLD 66/#108). Verify the completed player's stats reflect the match (do not assert exact numbers if a known fire-and-forget write race exists — see "flaky player-stats" memory; assert presence/round count, retry-tolerant). |
| 12 | Abstraction leak found during verification | If any Tonk-specific branch is needed in `TurnTimerService` or `socketHandler`, STOP and escalate to architect — do not add it. The DO-NOT constraint is load-bearing. |

## Dependencies

Must already exist on `origin/main` (all merged — branch from latest `origin/main`, not the local `fix-prod-migrate-workflow-parse-error` branch):

- **#1 (deckRoundsTarget backend)** — typed `game_config` JSONB column + migration 009 (#110). Tonk creatable/startable with a creator `deckRoundsTarget`.
- **#3 (Create Game + lobby UI, LLD 97/#111)** — game-type option, 3–8 player range, Deck Length stepper. Browser-creatable.
- **#59 (Tonk player actions UI, #114)** — `TonkActionPanel` / `TonkHand` / `TonkBoard`. Browser-playable. **This was the gating dependency** (per the triage note) and is now merged.
- **#2 (loss-centric stats, LLD 66/#108)** — stats recorded on completion.
- **LLD 98 / PR #113** — the per-phase re-arm code (`MAX_AUTO_ACTIONS_PER_SEAT`, widened `autoPlayAbandoned` bound) and `tests/integration/tonk-timer-rearm.test.ts`.
- **LLD 69 (Tonk engine)** — `getAutoTimeoutAction`, two-phase `applyAction`.
- **LLD 7a (turn timer)** — `TurnTimerService`, `TimerProvider`, `handleTimerExpired`.
- **Existing test infra** — `e2e/helpers/{game-helpers,seed-helpers}.ts`, `POST /test/seed-state` (test-mode only), `e2e/global-setup.ts` stored-auth files, `playwright.config.ts`.

No new package, schema, or migration dependency.

## Test Requirements

The unit and WS-integration tiers for re-arm already exist and must remain green; this LLD adds the **browser e2e** tier. Bias to automated tests (testing-principles §"Bias against manual tests").

### Pre-existing tests that must stay green (reference, do not duplicate)

- `tests/integration/tonk-timer-rearm.test.ts` — T1/T2 connected-AFK two-phase re-arm, T3 abandoned-chain through both phases, T4 completion mid-loop. This is the authoritative deterministic proof of the hard requirement.
- `tests/engine/tonk/auto-timeout.test.ts` — `getAutoTimeoutAction` per-phase action + determinism.
- Big2 timer tests (`tests/timer/*`, Big2 auto-timeout) — must be unaffected (Big2 stays 1 auto-action/seat).

### New e2e (Playwright, headless) — primary deliverable

**`e2e/tonk-full-game.spec.ts`**

| # | Test | Asserts |
|---|------|---------|
| F1 | Create Tonk via UI with 3 players and a chosen `deckRoundsTarget` (5–12), have 2 more players join, Start | Lands in a Tonk board (`tonk-board` visible), deal happened, current seat shown |
| F2 | Drive a real turn through the UI: select a card → discard → draw from stock | Phase stepper advances discard→draw→next seat; hand count returns to prior size; board updates for all clients |
| F3 | Seed a near-threshold tally, then complete the match by a browser-driven trick (callTonk when the gate is open, or a stock-out) | Game-over screen renders with winner + final tallies; `currentPlayerIndex === -1` |
| F4 | After F3 completion, the completing player's Tonk stats reflect the match | Stats view shows a Tonk entry / incremented round count (retry-tolerant per the known fire-and-forget race) |

**`e2e/tonk-turn-timeout.spec.ts`** (the hard requirement, browser tier)

| # | Test | Asserts |
|---|------|---------|
| T1 | Create a Tonk game with a short `turnTimerSeconds`; seed a discard-phase state where the current seat has a multi-card hand and healthy stock; let the clock run out (do not act) | Within the configured window the board shows the seat auto-discarded (hand −1, phase → draw) **and then** auto-drew (hand restored, seat advanced). The turn does **not** stall on the discard. |
| T2 | Same setup, observed by a spectator client | Spectator board reflects both auto-actions and the seat advance; spectator payload contains no hands |

**Spectate / reconnect / join-by-code** (same file or `tonk-create-lobby.spec.ts`)

| # | Test | Asserts |
|---|------|---------|
| S1 | Start a Tonk game with N players; a non-player opens the game URL / join flow and chooses spectate | Spectator sees `tonk-board` with counts/piles/log and **no** own-hand zone; can watch a live action update |
| S2 | A seated player reloads the page mid-game (during the draw phase) | After reconnect the player sees their own hand, the correct `turnPhase`, and the countdown (turnDeadline); game does not freeze |
| S3 | Join-by-code: read the lobby join code, a second player enters it on the join-game screen | Resolves to the Tonk game and joins the lobby (Tonk badge present); for an in-progress game, the spectate option is offered (CX §join-in-progress) |

### Security / information-hiding (assert within the e2e where cheap, else reference unit coverage)

- Spectator `game:spectatorState` payload contains no `hand` / `you.hand` for any player (S1; reference `tests/engine/tonk/information-hiding.test.ts` for the exhaustive unit proof).
- Spectator action attempts are rejected (`SPECTATOR_CANNOT_ACT`) — UI exposes no controls (E8).

### Manual verification (only what automation cannot cover)

| Step | Why manual |
|------|-----------|
| Visual sanity of the Tonk board during a full play-through (phase banner, seat rail, tally panel, discard/stock piles legible at 3 and 8 seats) | Layout/legibility is visual; automated DOM assertions cover presence, not aesthetics. Do once via `docker compose up` per DEVELOPMENT.md. |

### Outcome routing

- Run the new e2e **headless locally** before pushing; CI runs headless too.
- If F1–F4 / T1–T2 / S1–S3 all pass: the acceptance criteria are met; route to **qa** for the CX cross-check.
- If any test reveals a real defect (e.g., a genuine stall, a leaked hand, a wrong-phase control): **do not fix inline** — file/route the fix to the **implementer** against the owning LLD (98 timer, 69 engine, or 97 UI), then re-run this verification. If the defect is an abstraction leak in the timer/WS layer, escalate to **architect** (the DO-NOT constraint forbids Tonk special-casing there).
