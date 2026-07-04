# LLD 145: 'Total turns' value on the Tonk game-over screen looks wrong/confusing

## Scope

**Covers:** Suppressing the misleading "Total Turns" row on the Tonk game-over
screen. The row is gated so it renders **only for game types where the value is
meaningful (Big2)**.

**Does NOT cover:**

- Any change to the Tonk engine's `turnNumber` (root-cause context below explains
  why no engine change is needed).
- Relabeling the row or deriving a corrected turn/round count for Tonk. This was
  explicitly rejected during design selection (Option A only — hide the row).
- Big2 behavior. Big2's `turnNumber` stays plausible and its row is unchanged.
- Adding any new persisted field, migration, or engine action.

## Approach

**Decision: Option A — hide the "Total Turns" row entirely for Tonk. Gate on game
type, not on a value threshold.**

### Root cause (context only — no engine change)

`turnNumber` on `InternalGameState`/`PlayerView` is an internal monotonic
sequence number, incremented once per successful `(state, action)` transition. It
is not a "turns" figure a player can reason about:

- Big2: exactly one increment per player turn (play/pass) → stays plausible, maps
  cleanly to "Total Turns".
- Tonk: a real turn is **discard then draw**, so it increments **twice per player
  turn** (`tonk-engine.ts` discard handler line 376, draw handler line 511). It
  also increments **once on each round/deck reset** (lines 627, 704) and **never
  resets across the multi-round match** (`deckRoundsTarget` rounds). Over a
  multi-round, multi-player Tonk game it trivially accumulates to ~192.

Because the number is semantically fine for Big2 and semantically meaningless for
Tonk, the honest, minimal fix is to stop surfacing it for Tonk. We do **not**
touch the engine: `turnNumber` remains a valid internal sequence number used for
versioning/ordering, and mutating its semantics per game type would be a larger,
riskier change with no user benefit under Option A.

### Why gate on game type, not on `totalTurns > 0`

The current template gates the row on `v-if="totalTurns > 0"`. That is a value
threshold, not a semantic gate — a Tonk game with a large `turnNumber` passes it
and shows the confusing value. The fix replaces the gate with a game-type
predicate so the row renders **iff the value is meaningful for that game type**.
The `> 0` guard is retained as a secondary condition to preserve the existing
Big2 behavior (a Big2 game with `turnNumber === 0` still shows nothing).

### Wiring `gameType` into `GameOverView`

`GameOverView.vue` does not currently receive the game type. `GameView.vue`
already has it as `gameState.gameType`. Add a `gameType` prop to `GameOverView`
and bind it from `GameView.vue`. The row's gate becomes
`showTotalTurns = gameType === 'big2' && totalTurns > 0`.

Alternatives considered:

- **Pass a pre-computed `showTotalTurns` boolean from `GameView` instead of
  `gameType`.** Rejected: it leaks presentation logic into the parent and is less
  self-describing than the component owning its own gate. Passing `gameType` is
  the more reusable, honest interface and matches how other game-type branching is
  already done in `GameView.vue`.
- **Keep the value-threshold gate and clamp/hide only above some magic number.**
  Rejected: brittle, still shows wrong small values, and hides a real signal for
  Big2.

## Interfaces / Types

No changes to `src/shared/engine-types.ts`. `turnNumber` on `InternalGameState`
and `PlayerView` is unchanged.

`GameOverView.vue` props gain one optional field:

```ts
const props = defineProps<{
  // ...existing props unchanged...
  totalTurns?: number;
  gameType?: GameType; // NEW — "big2" | "tonk"; gates the Total Turns row
  // ...
}>();
```

`GameType` is imported from `@shared/engine-types` (already imported in
`GameView.vue`; add the import to `GameOverView.vue`).

`GameView.vue` binding (line ~117, in the `<GameOverView>` element):

```
:total-turns="gameState.turnNumber"
:game-type="gameState.gameType"   <!-- NEW -->
```

## State Model

No state-model change. `turnNumber` remains a server-authoritative internal
sequence number persisted as part of `InternalGameState` and surfaced verbatim in
`PlayerView`. This LLD only changes **presentation gating** in the frontend
(pure render logic). Nothing new is persisted; no in-memory cache or engine state
is affected.

Gate computed in `GameOverView.vue`:

```
showTotalTurns = (props.gameType === "big2") && (totalTurns > 0)
```

Template: replace `v-if="totalTurns > 0"` on `.game-over__metadata` with
`v-if="showTotalTurns"`.

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| E1 | Tonk game, any `turnNumber` (incl. 192) | Row hidden (`gameType !== 'big2'`). Primary fix. |
| E2 | Big2 game, `turnNumber > 0` | Row shown with the value — unchanged from today. |
| E3 | Big2 game, `turnNumber === 0` | Row hidden — unchanged from today (secondary `> 0` guard). |
| E4 | `gameType` prop omitted/undefined | Row hidden (`undefined !== 'big2'`). Fail-safe: prefer hiding an ambiguous metric over showing a possibly-wrong one. `GameView` always binds it, so this is defensive only. |
| E5 | `totalTurns` prop omitted/undefined | Existing `totalTurns` computed already defaults to `0` → row hidden. Unchanged. |
| E6 | Future third game type added | Row hidden by default until that engine's `turnNumber` semantics are validated and the gate is explicitly widened. Conservative and intentional. |

## Dependencies

- **Existing code only.** No upstream LLD is a hard dependency.
- Touches `src/frontend/component/game/GameOverView.vue` and
  `src/frontend/component/game/GameView.vue`.
- Relies on `gameState.gameType` (`GameType` from `@shared/engine-types`) already
  present on the `PlayerView` bound in `GameView.vue`.
- No backend, engine, migration, or shared-type changes.

## Frontend Design

**Approved direction: Option A — hide the "Total Turns" row entirely for Tonk.**

- Do **not** relabel the row and do **not** derive a corrected value for Tonk.
- `GameOverView.vue` currently renders the `.game-over__metadata` row
  (`Total Turns: {{ totalTurns }}`) gated only on `totalTurns > 0`. Change the
  gate to a game-type predicate so the row renders only for `big2`.
- Add a `gameType` prop to `GameOverView.vue`; bind it from `GameView.vue`
  (`:game-type="gameState.gameType"`).
- Introduce a `showTotalTurns` computed: `gameType === 'big2' && totalTurns > 0`.
  Bind the row with `v-if="showTotalTurns"`.
- **Big2 must be completely unchanged**: same label ("Total Turns"), same value
  (`gameState.turnNumber`), same styling, same fade-in animation
  (`game-over__fade-in game-over__fade-in--delay-1`), same `> 0` behavior.
- No new visual elements, layout shifts, or copy for Tonk. The Tonk game-over
  screen simply omits the row (the winner banner, score table, and stat cards are
  untouched). No mockup is required — this is a pure removal of one row for one
  game type, with zero new UI.

**Player-facing definition (documented per acceptance criteria):** For Big2,
"Total Turns" = the number of plays/passes taken across the game (one per player
turn). For Tonk, no turn/round figure is shown because the engine's internal
sequence number does not correspond to a player-reasonable turn count.

## Test Requirements

Follow `docs/testing-principles.md`. Frontend `<script setup>` logic is tested in
isolation (node env, no DOM mount) by transcribing the computed/gating logic —
mirror the pattern in `tests/frontend/gameOverFinalPlay.test.ts`. Add tests to a
new `tests/frontend/gameOverTotalTurns.test.ts`.

### Unit (gating logic)

Transcribe the `showTotalTurns` computed and assert:

1. **Tonk hides the row** — `gameType = 'tonk'`, `totalTurns = 192` → `showTotalTurns === false`. (Reproduces the reported bug.)
2. **Tonk hides the row for any value** — `gameType = 'tonk'`, `totalTurns = 1` and `totalTurns = 0` → `false`.
3. **Big2 shows the row when positive** — `gameType = 'big2'`, `totalTurns = 13` → `true`.
4. **Big2 hides the row when zero** — `gameType = 'big2'`, `totalTurns = 0` → `false` (Big2 behavior preserved).
5. **Undefined `gameType` hides the row** — `gameType = undefined`, `totalTurns = 10` → `false` (fail-safe, E4).
6. **Undefined `totalTurns` hides the row** — `gameType = 'big2'`, `totalTurns = undefined` → `false` (E5; existing default-to-0 behavior).

### Regression / manual

- Manual (visual, cannot be asserted on computed state alone): complete a Tonk
  game and confirm the game-over screen shows **no** "Total Turns" row; complete a
  Big2 game and confirm the row still appears with a plausible value and its
  fade-in animation. This is the only manual step; all gating logic is covered by
  the unit tests above.

No backend/engine tests are needed — the engine is unchanged.
