# LLD 14: Visible Timer Countdown Per Player

## Scope

### In scope

- New composable `useTurnCountdown` — shared countdown logic for all timer display components
- New component `TurnTimer.vue` — prominent center-area timer (replaces the plain `play-area__turn-banner` in PlayArea.vue)
- New component `OpponentTimer.vue` — compact inline ring per opponent, shown only for the active player
- Modifications to `PlayArea.vue`, `OpponentRow.vue`, and `GameBoard.vue` to wire through `turnDeadline` and `turnTimerSeconds`
- Typing fix in `useGameState.ts` to expose `turnDeadline` from `EnrichedPlayerView`
- CSS urgency states (calm, warning, critical) with SVG ring depletion animation
- `prefers-reduced-motion` support

### Out of scope

- Backend changes (timer logic is complete per LLD 7a — server already broadcasts `turnDeadline`)
- Sound or haptic feedback on urgency transitions
- Spectator view timer (can be added later using same composable against `EnrichedSpectatorView`)
- Timer pause/resume mechanics

---

## Approach

### Key technical decisions

1. **Client-local countdown from absolute deadline.** The server already broadcasts `turnDeadline` as an epoch ms value (LLD 7a). The frontend computes `remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))` locally. Zero additional WebSocket traffic.

2. **Shared composable (`useTurnCountdown`).** Both `TurnTimer.vue` and `OpponentTimer.vue` need the same countdown logic. A composable avoids duplication and is independently unit-testable.

3. **`setInterval(1000)` over `requestAnimationFrame`.** The countdown updates once per second (integer seconds). RAF is wasteful for 1Hz updates. The 1s interval provides sufficient visual accuracy for a turn timer and is battery-friendly on mobile.

4. **SVG ring depletion via `stroke-dashoffset`.** A single `<circle>` element with computed `stroke-dashoffset` creates the visual countdown arc. This is GPU-accelerated, resolution-independent, and requires no canvas or external library.

5. **Type the actual WebSocket payload.** `useGameState` currently types its state as `PlayerView`, but the socket emits `EnrichedPlayerView` (which includes `turnDeadline`). The composable will be updated to type-assert the enriched view so `turnDeadline` is available without runtime changes.

6. **Replace, not augment, the turn banner.** The existing `play-area__turn-banner` in `PlayArea.vue` is replaced by `TurnTimer.vue`, which incorporates the turn label text plus the countdown ring. This avoids showing two turn indicators.

7. **`totalSeconds` from `SerializableGame`.** The fraction for the ring is `remaining / total`. The `totalSeconds` value comes from the game's `turnTimerSeconds` configuration (already available in the REST game state response). `GameView.vue` passes it down through `GameBoard`.

---

## Interfaces / Types

### `useTurnCountdown` composable

```typescript
// src/frontend/composables/useTurnCountdown.ts

import type { Ref } from "vue";

export type Urgency = "calm" | "warning" | "critical";

export interface UseTurnCountdownReturn {
  /** Seconds remaining (integer, >= 0). Updates every 1s. */
  remainingSeconds: Ref<number>;
  /** Fraction remaining [0..1]. 1 = full time, 0 = expired. */
  fraction: Ref<number>;
  /** Urgency level based on remaining time. */
  urgency: Ref<Urgency>;
}

/**
 * Reactive countdown from an absolute deadline.
 *
 * @param turnDeadline - Epoch ms of when the turn expires. null = no timer (all refs go to 0/calm).
 * @param totalSeconds - Total configured timer duration in seconds. Used to compute fraction.
 */
export function useTurnCountdown(
  turnDeadline: Ref<number | null>,
  totalSeconds: Ref<number>,
): UseTurnCountdownReturn;
```

**Urgency thresholds:**
- `calm`: remainingSeconds > 10
- `warning`: 5 < remainingSeconds <= 10
- `critical`: remainingSeconds <= 5

**Lifecycle:** Starts a 1-second `setInterval` on component mount. Clears on unmount. Recomputes immediately when `turnDeadline` changes (via a `watch`).

### `TurnTimer.vue` props

```typescript
interface TurnTimerProps {
  turnDeadline: number | null;
  isMyTurn: boolean;
  currentPlayerName: string;
  totalSeconds: number;
}
```

### `OpponentTimer.vue` props

```typescript
interface OpponentTimerProps {
  turnDeadline: number | null;
  isActive: boolean;
  totalSeconds: number;
}
```

### `useGameState` type update

```typescript
// Change the type annotation from PlayerView to EnrichedPlayerView
import type { EnrichedPlayerView } from "@shared/socket-events";

// gameState now typed as ShallowRef<EnrichedPlayerView | null>
// This is a type-only change — the runtime data already includes turnDeadline.
```

### `GameBoard.vue` new props

```typescript
// Add to existing props:
interface GameBoardProps {
  // ... existing props ...
  turnDeadline: number | null;
  turnTimerSeconds: number | null;
}
```

### `PlayArea.vue` new props

```typescript
// Replace turn-banner logic with TurnTimer. Add:
interface PlayAreaProps {
  // ... existing props ...
  turnDeadline: number | null;
  totalSeconds: number;
}
```

### `OpponentRow.vue` new props

```typescript
// Add to existing props:
interface OpponentRowProps {
  // ... existing props ...
  turnDeadline: number | null;
  totalSeconds: number;
}
```

---

## State Model

### Data flow (no new server state)

```
Server broadcasts EnrichedPlayerView { ..., turnDeadline: 1718700000000 }
  -> useGameState stores as gameState.value (with turnDeadline accessible)
  -> GameView.vue passes gameState to GameBoard
  -> GameBoard passes turnDeadline + turnTimerSeconds to PlayArea and OpponentRow
  -> PlayArea renders TurnTimer with turnDeadline + totalSeconds
  -> OpponentRow renders OpponentTimer per opponent (v-if isActive)
  -> useTurnCountdown composable inside each timer:
       - setInterval(1000) recomputes: remaining = ceil((deadline - now) / 1000)
       - fraction = remaining / totalSeconds
       - urgency = derived from remaining
       - SVG ring offset = circumference * (1 - fraction)
```

### What changes on each turn

When the server broadcasts a new `game:state` with a fresh `turnDeadline`:
1. `gameState.value` is replaced (shallowRef triggers)
2. New `turnDeadline` prop flows to both timer components
3. The composable's `watch(turnDeadline)` fires, immediately recalculating `remainingSeconds`
4. SVG ring resets to full (or near-full) and begins depleting again

### When timer is not configured

If `turnTimerSeconds` is `null`, `turnDeadline` will always be `null`. Both timer components are guarded by `v-if="turnDeadline != null"` and render nothing. The existing turn banner text ("Your turn" / "[Name]'s turn") moves into `TurnTimer.vue` — when there is no timer, a minimal non-ring label is still shown.

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | `turnDeadline` is null (no timer configured) | TurnTimer renders label only (no ring, no seconds). OpponentTimer hidden entirely. |
| 2 | Client clock drift | Minor drift (<5s) is acceptable for a UI indicator. The server still enforces the real deadline. The countdown is cosmetic. |
| 3 | `turnDeadline` in the past (reconnection after timeout) | `remainingSeconds` computes to 0. Ring shows empty. Next `game:state` event will arrive with updated deadline. |
| 4 | Component unmounts mid-countdown | `onUnmounted` / `onScopeDispose` clears the interval. No leaks. |
| 5 | Very short remaining time on initial render (e.g., 2s left on reconnection) | Immediate urgency = "critical". Ring nearly empty. No special handling needed — the math is the same. |
| 6 | First turn has 2x duration (per LLD 7a) | The `turnDeadline` already accounts for this (server calculates `now + seconds * 2`). The `totalSeconds` prop should reflect the actual duration for this turn. **Decision:** Pass the un-doubled `turnTimerSeconds` as `totalSeconds`. The fraction will start at < 1.0 for the first turn once half the extended time elapses. This is intentional — the ring represents "time remaining relative to normal turn length" and will show as over-full (clamped to 1.0) for extended turns. Alternative: pass doubled value for first turn. Recommended approach: clamp fraction to [0, 1] in the composable. |
| 7 | Multiple opponents but only one is active | OpponentTimer rendered conditionally via `v-if="isActive"`. Only the active opponent shows the ring. |
| 8 | Game transitions to COMPLETED while timer is showing | `GameBoard` unmounts (GameView switches to GameOverView). All timers clean up via `onUnmounted`. |
| 9 | Tab goes to background (browser throttles timers) | When tab regains focus, the next interval tick will compute correct remaining time from `Date.now()`. May skip intermediate seconds visually but self-corrects immediately. |
| 10 | `totalSeconds` is 0 or negative (invalid config) | Guard: if `totalSeconds <= 0`, fraction = 0. This should not happen with validated configs (30/60/90). |

---

## Dependencies

- **LLD 7a (Turn Timer)** — implemented. Provides `turnDeadline` in `EnrichedPlayerView` and `turnTimerSeconds` on `SerializableGame`.
- **LLD 6 (Frontend Game UI)** — implemented. Provides `GameBoard.vue`, `PlayArea.vue`, `OpponentRow.vue`, `useGameState.ts`.
- **Existing files to modify:**
  - `src/frontend/composables/useGameState.ts` — type update
  - `src/frontend/component/game/GameBoard.vue` — prop passthrough
  - `src/frontend/component/game/GameView.vue` — pass `turnTimerSeconds` to GameBoard
  - `src/frontend/component/game-ui/PlayArea.vue` — replace turn-banner with TurnTimer
  - `src/frontend/component/game-ui/OpponentRow.vue` — add OpponentTimer
- **New files:**
  - `src/frontend/composables/useTurnCountdown.ts`
  - `src/frontend/component/game-ui/TurnTimer.vue`
  - `src/frontend/component/game-ui/OpponentTimer.vue`

---

## Test Requirements

### Unit tests: `useTurnCountdown` composable

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Returns `remainingSeconds = 0` when `turnDeadline` is null | No timer case |
| 2 | Computes correct `remainingSeconds` from a future deadline | `ceil((deadline - now) / 1000)` |
| 3 | `fraction` = `remainingSeconds / totalSeconds` clamped to [0, 1] | Ring fill correctness |
| 4 | `urgency` is "calm" when > 10s remaining | Threshold check |
| 5 | `urgency` is "warning" when 5 < remaining <= 10 | Threshold check |
| 6 | `urgency` is "critical" when remaining <= 5 | Threshold check |
| 7 | Updates `remainingSeconds` when `turnDeadline` ref changes | Reactivity to new turn |
| 8 | Clears interval on scope disposal | No timer leak |
| 9 | `fraction` clamps to 1.0 when remaining > totalSeconds (extended first turn) | No over-full ring |
| 10 | Returns 0 remaining when deadline is in the past | Reconnection edge case |

### Component tests: `TurnTimer.vue`

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Shows "Your turn" label when `isMyTurn` is true | Label text |
| 2 | Shows "[Name]'s turn" when `isMyTurn` is false | Label text |
| 3 | SVG ring is rendered when `turnDeadline` is non-null | Ring visibility |
| 4 | SVG ring is hidden when `turnDeadline` is null | Graceful degradation |
| 5 | Numeric seconds display uses `tabular-nums` | No layout shift |
| 6 | Applies "critical" class when urgency is critical | Visual urgency |

### Component tests: `OpponentTimer.vue`

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Not rendered when `isActive` is false | Conditional display |
| 2 | Shows ring and seconds when `isActive` is true and deadline is non-null | Active state |
| 3 | Hidden when `turnDeadline` is null even if `isActive` | No-timer game |

### Integration test (visual correctness, manual)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Start a game with 30s timer — TurnTimer shows countdown depleting from 30 | End-to-end visibility |
| 2 | Play a card — timer resets to 30 for next player | Timer restart |
| 3 | Wait for timeout — game log shows auto-pass message | Timer expiry UX |
| 4 | Start a game with no timer — no countdown ring visible anywhere | Null timer case |
| 5 | Mobile viewport (<767px) — timer is visible and not clipped | Responsive layout |
