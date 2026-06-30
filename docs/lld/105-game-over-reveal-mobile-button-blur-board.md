# LLD 105: Game-over reveal screen — continue button cut off on mobile + leftover placeholder board details

## Scope

A **presentation-layer follow-up to LLD 73** (the `SHOW_FINAL_PLAY` reveal phase, commit `a76301d`). Three frontend-only acceptance criteria on the Big2 game-over reveal:

### In scope (frontend only)

1. **Fix the cut-off "Continue to Results" button on mobile.** Root cause: `.game-view__board-container` uses `height: 100vh` (`GameView.vue:475-479`), which ignores the mobile browser URL bar, so the bottom-pinned ribbon falls below the visual viewport when the URL bar reveals. Mirror the in-game board fix (`GameBoard.vue:309-330`): `100dvh`-based sizing with a `100vh` fallback, and pin the action area `env(safe-area-inset-bottom)`-aware.
2. **Suppress stale turn-state UI when the game is over.** During `SHOW_FINAL_PLAY` the live `GameBoard` keeps rendering, so `TurnTimer.vue:43` renders `{{ currentPlayerName }}'s turn`; `currentPlayerName` (`GameBoard.vue:148-151`) falls back to `""` when the player at `currentPlayerIndex` is undefined/finished, producing a bare `"'s turn"`. Hide **both** the turn label and the timer ring when the game is over (no current turn). Also suppress the opponent active-turn indicators (`OpponentRow`) so no seat is shown as "to act".
3. **De-emphasize the live board behind the final cards (Direction A — Full Blur Scrim).** Apply a blur + dark radial scrim to the board layer; the winner announcement and final cards stay crisp on top. Click-to-continue, no auto-advance (unchanged from LLD 73).

### Explicitly NOT in scope

- Any backend, engine, socket protocol, data-model, or shared-type change. `status`, `winner`, `currentPlayerIndex`, `lastPlay` already arrive in the player view; this LLD only changes how the client renders them on the reveal screen.
- The game-over transition logic / display-phase state machine (LLD 73). The watcher, `SHOW_FINAL_PLAY` entry, reconnect-skip, and `skipToResults` are unchanged.
- The `GameOverView` results screen (LLD 73 already surfaces the final-play row there). No change.
- Tonk: Tonk has no `SHOW_FINAL_PLAY` phase (goes straight to `COMPLETED` — `GameView.vue:204-206`), so none of this applies to `TonkBoard`. The reveal ribbon is already Big2-gated (`GameView.vue:63`).
- Choosing between Direction A/B/C — locked to **A** by the approved mockup. Do not re-open.

---

## Approach

### Key decisions and rationale

1. **`100dvh` board container, matching the in-game board (AC 1).** Change `.game-view__board-container` from `height: 100vh` to the same dual-declaration pattern already proven in `GameBoard.vue`: `height: 100vh;` then `height: 100dvh;`. `dvh` tracks the *dynamic* viewport, so when the URL bar shows the container shrinks with it and the bottom-pinned action area stays in view. This is the smallest possible fix and reuses an existing, tested idiom.

2. **Pin the continue action to the visual-viewport bottom, safe-area-aware (AC 1).** Per the mockup, the CTA wrapper is `position: absolute; left/right/bottom: 0` inside the (now `dvh`-sized) reveal layer, with `padding-bottom: calc(<base> + env(safe-area-inset-bottom, 0px))` so it clears the iOS home indicator. The existing ribbon already pins to `bottom: 0`; the load-bearing fix is the `dvh` container plus the `env()` padding.

3. **Suppress turn-state via a single `gameOver` boolean prop threaded GameView → GameBoard → PlayArea → TurnTimer / OpponentRow (AC 2).** `GameView` already knows the phase; it passes `:game-over="displayPhase === 'SHOW_FINAL_PLAY'"` to `GameBoard`. `GameBoard` forwards it to `PlayArea` (which forwards to `TurnTimer`) and to `OpponentRow`. When `gameOver` is true: `TurnTimer` renders neither the "Your turn"/"'s turn" label nor the countdown ring; `OpponentRow` renders no active-turn highlight/indicator/timer. Rationale for a prop over deriving `status === "COMPLETED"` inside `GameBoard`: the reveal is intentionally shown *while* `status` is already `COMPLETED`, and the phase boolean is the exact, explicit condition we are fixing — it cannot drift from the reveal it gates, and it keeps `GameBoard` free of phase-machine knowledge. The prop is optional with a `false` default so `IN_PROGRESS` rendering is byte-for-byte unchanged.

4. **Direction A blur scrim on the board layer (AC 3).** Add a `.game-view__board-container--revealing` modifier (applied when `displayPhase === 'SHOW_FINAL_PLAY'`) that blurs + dims the board, plus a full-bleed radial-scrim reveal layer that hosts the winner text, final cards, and pinned CTA above the haze. The blur is applied to the **board wrapper**, not the reveal layer, so the winner/cards/CTA stay crisp. Replaces the current thin bottom ribbon (`.game-view__final-play-ribbon`) with the mockup's full-scrim reveal structure.

5. **Surface the final cards inside the reveal (Direction A) (AC 3).** Direction A shows the winning `lastPlay` cards crisply within the scrim (mockup `.reveal__final`), not only on the post-continue `GameOverView`. Reuse the existing `finalPlay` computed (`GameView.vue:257-262`) and the `GameCard` component (`size="medium"`). Render the block only when `finalPlay` is truthy with `cards.length > 0`; on a forfeit/no-play ending it is omitted and the reveal still shows winner + CTA.

6. **Respect `prefers-reduced-motion`.** Entrance animations (crown pop, winner/cards/CTA rise) are disabled under reduced motion; elements appear in place. The blur/scrim itself is static (no animation) and remains.

---

## Interfaces / Types

No shared-type changes. Three components gain one optional prop each.

### `GameBoard.vue` — additive prop

```typescript
const props = defineProps<{
  gameState: EnrichedPlayerView;
  selectedIndices: Set<number>;
  selectionCount: number;
  actionError: string | null;
  actionPending: boolean;
  turnTimerSeconds: number | null;
  roomCode: string;
  gameOver?: boolean; // NEW — true during SHOW_FINAL_PLAY; suppresses turn-state UI. Default false.
}>();
```

`GameBoard` passes `:game-over="props.gameOver"` to `PlayArea` and `OpponentRow`.

### `PlayArea.vue` — additive prop (forwarded to TurnTimer)

```typescript
const props = defineProps<{
  // ...existing...
  gameOver?: boolean; // NEW — forwarded to TurnTimer. Default false.
}>();
```

### `TurnTimer.vue` — additive prop

```typescript
const props = defineProps<{
  turnDeadline: number | null;
  isMyTurn: boolean;
  currentPlayerName: string;
  totalSeconds: number;
  gameOver?: boolean; // NEW — when true, render neither label nor countdown ring. Default false.
}>();
```

Template guard: wrap the ring-wrap and the label block in `v-if="!gameOver"` (the ring is already additionally gated on `turnDeadline !== null`). When `gameOver` is true the `TurnTimer` renders an empty/collapsed element — no label, no ring.

### `OpponentRow.vue` — additive prop

```typescript
const props = defineProps<{
  // ...existing...
  gameOver?: boolean; // NEW — when true, no opponent shows as active. Default false.
}>();
```

`isActive()` returns `false` for all seats when `gameOver` is true, suppressing the gold border, the pulsing `opponent__turn-indicator`, and the `OpponentTimer`.

### `GameView.vue` (local) — no type changes

`DisplayPhase` unchanged. Existing `finalPlay` and `winnerDisplayName` computeds reused. The template binds `:game-over="displayPhase === 'SHOW_FINAL_PLAY'"` on `<GameBoard>` and applies the `--revealing` class on the board container.

---

## Frontend Design

**Frontend decision: A (Full Blur Scrim) — APPROVED. Direction is locked.**

Reference mockup: `docs/mockups/game-over-reveal-mobile-button-blur-board.html` (on branch `lld-103-game-over-reveal-mobile-button-blur-board`).

### Layout

```
┌─────────────────────────────────────┐
│  opponents   (blurred + dimmed)      │ ← board layer:
│ ──────────────────────────────────── │   filter: blur(7px) brightness(0.55) saturate(0.8)
│        [ table ]   (blurred)         │   no active-turn highlight, no "'s turn" label
│        [ hand ]    (blurred)         │
│ ──────────────────────────────────── │
│                                       │
│              🏆                       │ ← reveal layer (crisp, above scrim):
│          Alice wins!                  │   radial dark scrim background
│                                       │
│          FINAL PLAY                   │
│          [♠A] [♥A]                    │ ← finalPlay cards (medium), gold-rimmed
│          Pair · played by Alice       │
│                                       │
│   ┌───────────────────────────────┐  │
│   │     Continue to Results       │  │ ← pinned to visual-viewport bottom,
│   └───────────────────────────────┘  │   env(safe-area-inset-bottom)-aware
└─────────────────────────────────────┘
```

### Board container (AC 1)

```css
.game-view__board-container {
  position: relative;
  width: 100vw;
  height: 100vh;   /* fallback for older browsers */
  height: 100dvh;  /* dynamic viewport — accounts for mobile URL bar */
}
```

### Board blur layer (AC 3 — Direction A)

```css
.game-view__board-container--revealing :deep(.game-board) {
  filter: blur(7px) brightness(0.55) saturate(0.8);
  transform: scale(1.02); /* hides blur-edge gutter */
  transition: filter 0.4s ease, transform 0.4s ease;
  pointer-events: none;   /* board is non-interactive during reveal */
}
```

`:deep()` is required because the blur targets the child `GameBoard`'s root from `GameView`'s scoped styles. The board layer stays in DOM (so the final cards' source `PlayArea` and opponents remain, blurred) but is non-interactive. The crisp final cards are re-rendered in the reveal layer above.

### Reveal layer + scrim (AC 3)

```css
.game-view__reveal {
  position: absolute;
  inset: 0;
  z-index: 101; /* above board wood-rim (z-index 100) */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 32px;
  background: radial-gradient(
    ellipse 70% 55% at 50% 42%,
    rgba(10, 6, 3, 0.55) 0%,
    rgba(8, 5, 2, 0.82) 100%
  );
}
```

Winner text: `var(--gold-accent)`, `text-shadow: 0 0 28px var(--gold-glow)`; smaller on mobile (`max-width: 767px`). Final-play cards get a subtle gold outline + lift (`outline: 1px solid rgba(201,168,76,0.5); box-shadow: 0 8px 28px rgba(0,0,0,0.7)`), per mockup `.reveal__final .card`.

### Pinned CTA (AC 1 + AC 3)

```css
.game-view__reveal-cta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 18px 24px calc(18px + env(safe-area-inset-bottom, 0px));
  display: flex;
  justify-content: center;
}
```

Button keeps the existing gold styling, `min-height: 52px` touch target, full-width on mobile (`width: 100%`). `data-testid="continue-to-results"` is preserved so existing E2E selectors keep working. The reveal layer's root keeps `data-testid="final-play-overlay"`.

### Suppressed turn-state (AC 2)

- `TurnTimer`: `v-if="!gameOver"` on the ring-wrap and the label → no countdown, no "Your turn"/"'s turn". This is the literal fix for the orphan `"'s turn"`.
- `OpponentRow`: `isActive()` short-circuits to `false` when `gameOver` → no gold border, no pulsing dot, no opponent timer.
- These are visible *through the blur* (board layer stays in DOM), so suppressing them removes the distracting stale detail even behind the scrim.

### Animations + reduced motion

- Entrance: crown `pop`, winner/final/CTA `rise` (mockup keyframes), short staggered delays.
- Board blur transitions in over 0.4s.
- `@media (prefers-reduced-motion: reduce)`: disable `pop`/`rise` (appear in place) and the board `filter`/`transform` transition (blur appears immediately, no animation).

---

## State Model

No state-machine change. `displayPhase` (`GameView.vue:196`) remains the single transient UI state:

```
IN_PROGRESS ──(status→COMPLETED, was IN_PROGRESS, big2)──> SHOW_FINAL_PLAY
                                                                 │
                                            user clicks "Continue to Results"
                                                                 │ skipToResults()
                                                                 ▼
                                                            COMPLETED (GameOverView)
```

- `gameOver` is **derived**, not stored: `displayPhase === 'SHOW_FINAL_PLAY'`. It is true only on the reveal screen and false everywhere else.
- The blur class `--revealing` is bound to the same condition.
- Nothing persisted. No socket/engine interaction changes. The board layer continues to receive `game:state` updates while blurred (harmless; the game is over and no further updates arrive in practice).

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Mobile URL bar reveals on scroll during `SHOW_FINAL_PLAY` | Container is `100dvh`, so it shrinks with the visual viewport; the `bottom: 0` CTA stays in view. **Primary AC-1 fix.** |
| 2 | iOS device with home indicator | CTA `padding-bottom` includes `env(safe-area-inset-bottom)`; button clears the indicator. |
| 3 | Game over, `currentPlayerIndex` points at a finished/undefined seat | `gameOver` is true → `TurnTimer` renders no label (no bare `"'s turn"`) and `OpponentRow` shows no active seat. **Primary AC-2 fix.** |
| 4 | Disconnection-forfeit ending — `lastPlay` is `null` | Reveal shows winner + CTA; the `.reveal__final` card block is omitted (guarded on `finalPlay && cards.length > 0`). No crash, no empty box. Board behind still blurs. |
| 5 | Reconnect / join an already-`COMPLETED` game | Watcher sets `displayPhase = COMPLETED` directly (LLD 73 behavior preserved) → never enters `SHOW_FINAL_PLAY`, so no blur/reveal, `gameOver` is false, goes straight to `GameOverView`. |
| 6 | Tonk completion | Tonk goes straight to `COMPLETED`; reveal layer is Big2-gated; `gameOver` prop stays false for any live board it renders. No change to Tonk. |
| 7 | `prefers-reduced-motion` | Entrance animations and blur transition disabled; reveal + blur appear in place, fully functional. |
| 8 | Browser without `dvh` support | `height: 100vh` fallback declared first; `dvh` line is ignored by such browsers, behavior reverts to today's (acceptable; modern mobile browsers support `dvh`). |
| 9 | Browser without `:deep()`/`filter` support for blur | Blur silently no-ops; the radial scrim + crisp reveal layer still de-emphasize the board. Functional, slightly less polished. |
| 10 | Desktop (wide viewport) | `dvh == vh`; blur + scrim + centered reveal + pinned CTA all render; no regression. |
| 11 | User never clicks Continue | Stays on reveal indefinitely (LLD 73 linger behavior); no timers, no leak. |

---

## Dependencies

- **LLD 73** (`docs/lld/73-game-over-final-cards-reveal-timer.md`) — this LLD modifies the reveal it introduced. Read first.
- **Approved mockup:** `docs/mockups/game-over-reveal-mobile-button-blur-board.html` (branch `lld-103-...`) — Direction A is the locked visual target.
- **Existing code to modify:**
  - `src/frontend/component/game/GameView.vue` — board container `100dvh`; replace `.game-view__final-play-ribbon` with the Direction-A reveal layer (scrim + winner + final cards + pinned CTA); add `--revealing` blur modifier; bind `:game-over` on `GameBoard`. Reuse existing `finalPlay` + `winnerDisplayName` computeds.
  - `src/frontend/component/game/GameBoard.vue` — add optional `gameOver` prop; forward to `PlayArea` and `OpponentRow`.
  - `src/frontend/component/game-ui/PlayArea.vue` — add optional `gameOver` prop; forward to `TurnTimer`.
  - `src/frontend/component/game-ui/TurnTimer.vue` — `v-if="!gameOver"` on ring-wrap and label.
  - `src/frontend/component/game-ui/OpponentRow.vue` — add optional `gameOver` prop; `isActive()` returns false when set.
  - `src/frontend/component/game-ui/GameCard.vue` — reused unchanged (`size="medium"`).
- **Reused types:** `EnrichedPlayerView`, `Big2PublicState`, `Big2Play` — unchanged.

No new dependencies, no backend/socket/data-model/engine changes.

---

## Test Requirements

### Unit — turn-state suppression (`tests/frontend/TurnTimer.test.ts`, extend)

| # | Test | Verifies |
|---|------|----------|
| 1 | `gameOver=true` → no `.turn-timer__label` rendered (no "Your turn", no "'s turn") | AC 2 — orphan `"'s turn"` gone |
| 2 | `gameOver=true` → no countdown ring (`.turn-timer__ring-wrap`) rendered even when `turnDeadline` is set | Timer suppressed at game over |
| 3 | `gameOver=false` (default/omitted) with `isMyTurn=false`, a name → renders `{name}'s turn` | No regression to live rendering |
| 4 | `gameOver=false` default when prop omitted | Optional-prop backward compatibility |

### Unit — opponent active-turn suppression (`tests/frontend/` new or extend OpponentRow coverage)

| # | Test | Verifies |
|---|------|----------|
| 1 | `gameOver=true` → `isActive()` returns false for the seat at `currentPlayerIndex` (no active highlight/indicator/timer) | AC 2 — no seat shown as "to act" |
| 2 | `gameOver=false` → `isActive()` true for `currentPlayerIndex` seat | No regression |

### Unit — gameOver derivation (`tests/frontend/gameOverTransition.test.ts`, extend)

| # | Test | Verifies |
|---|------|----------|
| 1 | `displayPhase === 'SHOW_FINAL_PLAY'` ⇒ `gameOver` is true | Reveal screen suppresses turn-state |
| 2 | `displayPhase` in `IN_PROGRESS` / `COMPLETED` / `CREATED` ⇒ `gameOver` is false | Suppression scoped to the reveal only |

(Existing LLD-73 transition tests stay green — no state-machine change.)

### Component — reveal final-play block (extend `tests/frontend/gameOverFinalPlay.test.ts` or new GameView render test)

| # | Test | Verifies |
|---|------|----------|
| 1 | During `SHOW_FINAL_PLAY` with `finalPlay` cards, the reveal renders one card per `finalPlay.cards` entry crisply (not inside the blurred board layer) | AC 3 — cards prominent |
| 2 | `finalPlay = null` (forfeit) → reveal renders winner + CTA, no final-play card block, no crash | Edge case 4 |
| 3 | Continue button present with `data-testid="continue-to-results"`; clicking calls `skipToResults` (phase → COMPLETED) | CTA wiring preserved |

### Manual / E2E (mobile render — required; the primary bug is mobile-specific and CSS-driven)

DOM assertions cannot verify `dvh` / URL-bar geometry or visual blur. These are the necessary manual checks.

| # | Check | How |
|---|-------|-----|
| 1 | Continue button fully visible and tappable with the URL bar **shown** | Phone-width viewport (e.g. 390×844 Chrome DevTools / real device); reach game over, reveal the URL bar by scrolling, confirm CTA is on-screen and tappable. **AC 1.** |
| 2 | Continue button visible with URL bar **hidden** | Same viewport, URL bar collapsed. **AC 1.** |
| 3 | No `"'s turn"` (or bare `'s turn`) text anywhere on the reveal screen | Visual + DOM scan at game over on desktop and mobile. **AC 2.** |
| 4 | Board is visibly blurred/dimmed; winner + final cards crisp on top | Reach game over; confirm Direction-A scrim. **AC 3.** |
| 5 | Reduced-motion: reveal + blur appear without animation, fully usable | OS reduced-motion on; reach game over. |
| 6 | Forfeit ending: reveal renders (winner + CTA, no card block), no crash | Force a disconnection-forfeit completion. |
| 7 | Reconnect to completed game skips reveal, goes straight to results | Refresh on a completed `/game/:id`. |
