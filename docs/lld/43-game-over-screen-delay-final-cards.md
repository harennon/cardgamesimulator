# LLD 43: Game Over Screen Delay — Show Final Cards Before Transition

## Scope

### In scope

- Introduce a timed intermediate display state (`SHOW_FINAL_PLAY`) between `IN_PROGRESS` and showing `GameOverView` in `GameView.vue`
- During this state, the `GameBoard` remains visible with an overlay banner announcing the winner and a "Continue to Results" button
- Auto-transition to the full `GameOverView` after 4 seconds if no user interaction
- Allow immediate skip via tap/click on the continue button

### Out of scope

- Backend changes (this is a frontend-only fix — the server still emits `status: "COMPLETED"` immediately)
- Animated card reveal or replay of the final play (cards are already visible on the board via `lastPlay`)
- Changes to `useGameState.ts` — the composable still updates `status` to `COMPLETED` immediately; the delay is purely in the view layer
- Spectator view transition (can follow same pattern later)
- Related issue #26 (show previous played cards during gameplay)

---

## Approach

### Key technical decisions

1. **Frontend-only computed display state.** `GameView.vue` introduces a local `displayPhase` ref that decouples what is shown from the raw `status` value. When `status` transitions from `IN_PROGRESS` to `COMPLETED`, `displayPhase` enters `SHOW_FINAL_PLAY` for 4 seconds before advancing to `COMPLETED`. This avoids touching `useGameState.ts` or any backend code.

2. **GameBoard stays mounted with an overlay.** During `SHOW_FINAL_PLAY`, the existing `GameBoard` component remains rendered (so the final cards on the table are visible). A semi-transparent overlay with the winner announcement and "Continue" button is rendered on top. This is simpler and more reliable than freezing state — the board is already displaying the correct final play.

3. **Timer with early skip.** A 4-second `setTimeout` auto-advances to the results screen. The "Continue to Results" button immediately advances. Either path clears the timer and sets `displayPhase` to `COMPLETED`.

4. **Visual countdown indicator.** A small animated progress bar on the overlay shrinks over 4 seconds (CSS animation), providing clear feedback that this is a timed pause, not a broken state.

5. **No new composable.** The logic is simple enough (one ref, one setTimeout, one watcher) that it lives directly in `GameView.vue`'s `<script setup>`. Extracting a composable adds indirection without value.

---

## Interfaces / Types

### New type in `GameView.vue` (local, not exported)

```typescript
type DisplayPhase = "CREATED" | "IN_PROGRESS" | "SHOW_FINAL_PLAY" | "COMPLETED";
```

### New refs in `GameView.vue`

```typescript
const displayPhase = ref<DisplayPhase>("CREATED");
const finalPlayTimerId = ref<ReturnType<typeof setTimeout> | null>(null);
```

### New computed replacing `effectiveStatus` in template guards

```typescript
// effectiveStatus remains for determining raw game state
// displayPhase gates what is rendered in the template
```

### Overlay component (inline in GameView.vue or small sub-component)

If extracted as a component:

```typescript
// src/frontend/component/game/GameOverBanner.vue
defineProps<{
  winnerName: string;
  durationMs: number; // for CSS animation timing
}>();

defineEmits<{
  continue: [];
}>();
```

---

## State Model

### Display phase state machine

```
               status becomes COMPLETED
IN_PROGRESS ──────────────────────────────> SHOW_FINAL_PLAY
                                                    │
                                         ┌──────────┴──────────┐
                                         │                     │
                                    4s timeout          user clicks "Continue"
                                         │                     │
                                         └──────────┬──────────┘
                                                    ▼
                                              COMPLETED
                                        (render GameOverView)
```

### Watcher logic (pseudocode)

```typescript
watch(effectiveStatus, (newStatus, oldStatus) => {
  if (newStatus === "COMPLETED" && oldStatus === "IN_PROGRESS") {
    displayPhase.value = "SHOW_FINAL_PLAY";
    finalPlayTimerId.value = setTimeout(() => {
      displayPhase.value = "COMPLETED";
      finalPlayTimerId.value = null;
    }, 4000);
  } else if (newStatus === "COMPLETED") {
    // Joined/reconnected to an already-completed game — skip delay
    displayPhase.value = "COMPLETED";
  } else if (newStatus === "IN_PROGRESS") {
    displayPhase.value = "IN_PROGRESS";
  } else if (newStatus === "CREATED") {
    displayPhase.value = "CREATED";
  }
});
```

### Skip handler

```typescript
function skipToResults(): void {
  if (finalPlayTimerId.value) {
    clearTimeout(finalPlayTimerId.value);
    finalPlayTimerId.value = null;
  }
  displayPhase.value = "COMPLETED";
}
```

### Cleanup on unmount

```typescript
onUnmounted(() => {
  if (finalPlayTimerId.value) clearTimeout(finalPlayTimerId.value);
});
```

### Template change summary

Replace the current `v-else-if` chain condition for `GameBoard` and `GameOverView`:

- `GameBoard` renders when `displayPhase === 'IN_PROGRESS' || displayPhase === 'SHOW_FINAL_PLAY'`
- The winner overlay renders when `displayPhase === 'SHOW_FINAL_PLAY'`
- `GameOverView` renders when `displayPhase === 'COMPLETED'`

---

## Frontend Design

### Winner overlay during SHOW_FINAL_PLAY

The overlay is positioned absolute over the GameBoard. It does NOT hide the board — the final played cards remain visible beneath.

```
┌─────────────────────────────────────────────┐
│                 GameBoard                     │
│  (opponents, table with last play, hand)     │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ │
│  │         🏆  Alice wins!                  │ │
│  │                                          │ │
│  │      [ Continue to Results ]             │ │
│  │                                          │ │
│  │  ████████████████░░░░░  (progress bar)   │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Overlay styling

- Semi-transparent dark background: `rgba(0, 0, 0, 0.6)` with `backdrop-filter: blur(2px)`
- Centered vertically and horizontally
- Winner text: large, gold color (`--gold-accent`), with text-shadow glow
- "Continue to Results" button: same style as existing `game-over__btn--home` (gold background, dark text)
- Progress bar: thin (4px height), gold fill shrinking left-to-right over 4 seconds via CSS `animation: shrink 4s linear forwards`
- Minimum touch target 48px on the button for mobile

### Mobile considerations

- Overlay uses same absolute positioning — works identically on mobile since `GameBoard` already handles mobile layout
- Button has `min-height: 48px` and sufficient padding for touch
- Text sizes use the same responsive scaling as the existing game board

### Animation

- Overlay fades in (200ms opacity transition)
- Progress bar shrinks from 100% to 0% width over 4 seconds (pure CSS, `@keyframes shrink`)
- Respect `prefers-reduced-motion`: skip fade, show overlay immediately, still auto-advance after 4s

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Player joins/reconnects to an already-completed game | `effectiveStatus` starts as `COMPLETED` without transitioning from `IN_PROGRESS`. The watcher detects `oldStatus !== 'IN_PROGRESS'` and sets `displayPhase` directly to `COMPLETED`, skipping the delay. |
| 2 | Timer-forced auto-pass ends the game | Same path — server sends `game:state` with `status: "COMPLETED"`. The overlay still shows for 4s. The auto-played cards are visible in the `lastPlay` on the board. |
| 3 | Player leaves/navigates away during SHOW_FINAL_PLAY | `onUnmounted` clears the timeout. No leaked timers. |
| 4 | Game ends via abandoned player auto-plays (disconnection forfeit) | Treated identically — the final state has `status: "COMPLETED"` and the board shows whatever the last action was. |
| 5 | Multiple rapid `game:state` events with `COMPLETED` status (reconnection edge case) | The watcher only triggers on `effectiveStatus` change. Multiple events with the same status value do not re-trigger. If somehow triggered again, the timer is already null (cleared on first advance), so no double-advance. |
| 6 | `gameState` is null when status becomes COMPLETED | The `v-else-if` for `GameBoard` already requires `gameState` to be truthy. If null, neither board nor overlay renders — falls through to loading state. This is defensive; in practice `gameState` is always populated before status changes. |
| 7 | Very fast game (1-2 turns) | Same behavior. Even if the game lasted 5 seconds, the 4-second reveal is appropriate because the final play is the climactic moment. |
| 8 | `prefers-reduced-motion` enabled | CSS animation is disabled but timer still runs. Overlay appears immediately (no fade), auto-advances after 4s. User can still click to skip. |

---

## Dependencies

- **LLD 38 (Post-Match Stats)** — `GameOverView` already receives `playHistory`, `currentPlayerId`, `totalTurns` props. This LLD does not change those interfaces.
- **Existing code:**
  - `src/frontend/component/game/GameView.vue` — modified (template conditions, new refs/watcher)
  - `src/frontend/component/game/GameBoard.vue` — unchanged (still receives same props)
  - `src/frontend/component/game/GameOverView.vue` — unchanged
  - `src/frontend/composables/useGameState.ts` — unchanged
  - `src/frontend/styles/game-variables.css` — uses existing CSS variables

---

## Test Requirements

### Unit tests: display phase logic (`tests/frontend/gameOverTransition.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Status IN_PROGRESS -> COMPLETED sets displayPhase to SHOW_FINAL_PLAY | Transition triggers intermediate state |
| 2 | After 4000ms, displayPhase advances to COMPLETED | Timer auto-advances |
| 3 | Calling skipToResults before timer fires sets displayPhase to COMPLETED immediately | Early skip works |
| 4 | Calling skipToResults clears the pending timer | No leaked timeouts |
| 5 | Status starts as COMPLETED (reconnect) sets displayPhase to COMPLETED directly | No delay on reconnect |
| 6 | Status CREATED -> IN_PROGRESS sets displayPhase to IN_PROGRESS | Normal game start |
| 7 | Unmount during SHOW_FINAL_PLAY clears timer | Cleanup on destroy |

### Integration tests (if applicable)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Full game completion shows game board for >0ms before game over screen | E2E: final cards visible during transition |
| 2 | Clicking "Continue to Results" during SHOW_FINAL_PLAY shows GameOverView | User can skip |

### Manual verification

| # | Check | How |
|---|-------|-----|
| 1 | Final cards visible after game ends | Play a 4-player game to completion; verify lastPlay cards remain on screen for ~4 seconds |
| 2 | Overlay appears with winner name and progress bar | Visual inspection after game ends |
| 3 | "Continue to Results" button works on mobile | Test on iPhone 16 (or Chrome DevTools 390x844) |
| 4 | Auto-advance after 4s without interaction | Let timer expire; verify GameOverView appears |
| 5 | Reconnecting to completed game shows results immediately | Refresh page on a completed game URL |
| 6 | Timer auto-pass game ending shows overlay correctly | Let turn timer expire on final play |
