# LLD 73: Game Over Screen — Keep Final Cards Visible, Remove Reveal Time Pressure

## Scope

This is a **follow-up to LLD 43** (issue #51 / PR #52), not a re-build. The `SHOW_FINAL_PLAY` reveal phase in `GameView.vue` already exists and works. This LLD fixes the two unaddressed deltas reported by a user:

### In scope (frontend only)

1. **Fix the load-bearing bug:** the `SHOW_FINAL_PLAY` overlay (`GameView.vue` `.game-view__final-play-overlay`, currently `rgba(0,0,0,0.6)` + `backdrop-filter: blur(2px)` covering `inset: 0`) **dims and blurs the entire board, hiding the final cards** — especially noticeable on mobile where the board is small. Replace the full-screen dim+blur with a **bottom ribbon / spotlight** treatment (frontend-architect approved direction B) so the `lastPlay` cards stay clearly visible underneath.
2. **Remove time pressure:** the hardcoded `setTimeout(..., 4000)` auto-advance (`GameView.vue:158`) is replaced with **click-to-continue** — the phase does NOT auto-advance; the user advances by clicking "Continue to Results". This fully satisfies the "I want longer" request without forcing a 30s wait on everyone.
3. **Surface the final play on `GameOverView`:** add a small, read-only "final play" row to `GameOverView.vue` so the cards remain reviewable after the user has continued past the board phase. This addresses the literal "game over screen does not display final cards played" wording.
4. Update the existing `tests/frontend/gameOverTransition.test.ts`, which asserts the 4000ms behavior and will otherwise break.

### Explicitly NOT in scope

- The engine, data model, socket protocol, or any backend code (no changes — `lastPlay` already arrives in `gameSpecificPublicState`).
- Rebuilding the `SHOW_FINAL_PLAY` mechanism, the display-phase state machine, the winner banner concept, or the skip button (all exist from LLD 43).
- `useGameState.ts` (still updates `status` to `COMPLETED` immediately; the phase decoupling stays in the view layer).
- Spectator view, rematch, animated card replay, or post-match stats content (LLD 38 / 66).
- Reconnect behavior (preserved as-is — see Edge Cases).

---

## Approach

### Key decisions and rationale

1. **Click-to-continue instead of a longer timer (AC option b).** The acceptance criteria offer "(a) bump default to 6-8s" or "(b) no auto-advance, wait for click." We choose (b). A fixed timer cannot satisfy both "I want 30s to study" and "don't make everyone wait" — any constant is wrong for someone. Removing auto-advance lets each player linger as long as they want and continue instantly when ready. This deletes the `setTimeout`, the `finalPlayTimerId` ref, the timer-cleanup branches, and the CSS progress bar entirely. **No timer remains, so no named-constant duration is needed** (the AC's named-constant requirement only applies "if a timer is kept").

2. **Ribbon/spotlight overlay, not full-board dim.** The bug is that the overlay obscures the very cards it is meant to reveal. The fix: drop `backdrop-filter: blur` and the full-screen `rgba(0,0,0,0.6)` fill. Instead render the winner text + continue button as a **bottom ribbon** anchored to the bottom of the board (a contained panel with its own background), leaving the table — where `PlayArea` renders `lastPlay` — fully un-dimmed and un-blurred. See Frontend Design.

3. **Reuse existing `lastPlay` data for the GameOverView row.** `GameView` already derives `gameOverPlayHistory` from `gameState.gameSpecificPublicState`. We derive a `finalPlay` computed from the same source and pass it as a new optional prop to `GameOverView`. `GameOverView` renders a compact, non-interactive card row reusing the existing `GameCard` component (`size="small"`). No new shared types.

4. **No new composable, no new sub-component required.** The change is a CSS/template edit in `GameView.vue` plus an additive prop + template block in `GameOverView.vue`. Extracting components adds indirection without value (consistent with LLD 43's decision).

5. **Graceful null handling.** On a disconnection-forfeit or a game that ends with no recorded play, `lastPlay` may be `null`. Both the board ribbon (which only needs the winner name) and the new `GameOverView` row must render correctly with no cards and no crash/blank.

---

## Interfaces / Types

No shared type changes. One additive optional prop on `GameOverView.vue`.

### `GameView.vue` (local)

`DisplayPhase` type is unchanged (`"CREATED" | "IN_PROGRESS" | "SHOW_FINAL_PLAY" | "COMPLETED"`).

Removed: `finalPlayTimerId` ref and all `setTimeout`/`clearTimeout` usage.

New computed, derived from the same source as the existing `gameOverPlayHistory`:

```typescript
// Big2Play | null — the final cards on the table
const finalPlay = computed<Big2Play | null>(() => {
  const publicState = gameState.value?.gameSpecificPublicState as
    | Big2PublicState
    | undefined;
  return publicState?.lastPlay ?? null;
});
```

### `GameOverView.vue` — additive prop

```typescript
const props = defineProps<{
  scores: readonly PlayerScore[];
  winner: string;
  players: readonly PlayerPublicInfo[];
  isGuest: boolean;
  gameId: string;
  playHistory?: readonly Big2HistoryEntry[];
  currentPlayerId?: string;
  totalTurns?: number;
  finalPlay?: Big2Play | null; // NEW — final cards played; null/undefined renders no row
}>();
```

`Big2Play` is imported from `@shared/big2-types` (already used elsewhere). The hand-type label mapping (`HAND_TYPE_LABELS`) already exists in `PlayArea.vue`; `GameOverView` may inline the same small map or omit the label — label is optional polish, the cards are the requirement.

---

## State Model

### Display phase state machine (timer branch removed)

```
               status becomes COMPLETED
IN_PROGRESS ──────────────────────────────> SHOW_FINAL_PLAY
                                                    │
                                       user clicks "Continue to Results"
                                                    │
                                                    ▼
                                              COMPLETED
                                        (render GameOverView)
```

There is no longer any auto-advance edge out of `SHOW_FINAL_PLAY`. The only exit is the user clicking Continue (`skipToResults`, which keeps its name and behavior minus the timer-clearing).

### Watcher logic (after change)

```typescript
watch(effectiveStatus, (newStatus, oldStatus) => {
  if (newStatus === "COMPLETED" && oldStatus === "IN_PROGRESS") {
    displayPhase.value = "SHOW_FINAL_PLAY"; // wait for user; no setTimeout
  } else if (newStatus === "COMPLETED") {
    displayPhase.value = "COMPLETED"; // reconnect: straight to results
  } else if (newStatus === "IN_PROGRESS") {
    displayPhase.value = "IN_PROGRESS";
  } else if (newStatus === "CREATED") {
    displayPhase.value = "CREATED";
  }
});
```

### Continue handler (timer logic removed)

```typescript
function skipToResults(): void {
  displayPhase.value = "COMPLETED";
}
```

### Cleanup on unmount

The `onUnmounted` timer-clear line (`if (finalPlayTimerId.value) clearTimeout(...)`) is removed along with the ref. The remaining `unbindState/unbindActions/disconnect` calls are unchanged.

### Persisted vs in-memory

Nothing persisted. `displayPhase` is transient local UI state. All game state still flows from the server via `game:state`; this LLD does not change what is sent or stored.

---

## Frontend Design

**Frontend decision: approved (direction B — ribbon/spotlight).**

### SHOW_FINAL_PLAY board overlay — before vs after

The board (with `PlayArea` showing `lastPlay`) stays fully visible and undimmed. The winner announcement + continue action move to a **bottom ribbon** that does not cover the table.

```
┌─────────────────────────────────────────────┐
│  opponents                                    │
│ ───────────────────────────────────────────  │
│                                               │
│            [ FINAL PLAY CARDS ]   ← un-dimmed │
│              played by Alice                  │
│                                               │
│ ───────────────────────────────────────────  │
│  your hand                                    │
│ ┌───────────────────────────────────────────┐│
│ │  🏆 Alice wins!     [ Continue to Results ]││  ← bottom ribbon
│ └───────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

### Ribbon styling

- Replace `.game-view__final-play-overlay` full-screen fill with a bottom-anchored ribbon: `position: absolute; left: 0; right: 0; bottom: 0;` (above the board's wood-rim `z-index: 100`, so use `z-index: 101+`).
- **Remove `backdrop-filter: blur(2px)`** and the `inset: 0` `rgba(0,0,0,0.6)` full fill. The ribbon has its own opaque/semi-opaque panel background (`var(--panel-bg)` or a gold-tinted gradient) with a top border (`--gold-accent`) and a soft upward shadow to lift it off the felt.
- Layout: winner text left/center, "Continue to Results" button right (stack vertically on mobile).
- Winner text: gold (`--gold-accent`), with the existing text-shadow glow, but sized to fit a ribbon (smaller than the old centered headline).
- Button: keep existing `.game-view__final-play-btn` styling (gold bg, dark text, `min-height: 48px` touch target).
- **Remove** the progress-bar element and the `@keyframes shrink` animation (no timer to visualize).
- Optional gentle attention cue: a one-shot slide-up entrance for the ribbon (`transform: translateY(100%) → 0`, ~200ms). Respect `prefers-reduced-motion` (no transform; ribbon appears in place).

### GameOverView "final play" row

A compact, read-only row inside `.game-over__panel`, placed below the winner headline and above (or just above) the scores table:

```
┌──── game over panel ────┐
│      Alice wins!         │
│                          │
│  FINAL PLAY              │
│  [♠A][♥A]  Pair          │  ← small cards, read-only
│  played by Alice         │
│ ──────────────────────── │
│  scores table…           │
└──────────────────────────┘
```

- Render only when `finalPlay` is truthy and `finalPlay.cards.length > 0`. If null/empty (forfeit, no play), the row is omitted entirely — no empty box.
- Reuse `GameCard` with `size="small"`. Cards are non-interactive (no `interactive`, no toggle handler).
- Small uppercase label ("Final Play") in `--gold-accent` consistent with `PlayArea`'s `.play-area__hand-label`. Optional hand-type label and "played by {name}" line (resolve name from `players` by `finalPlay.playerId`).
- Mobile: cards wrap/shrink within the panel; reuse existing panel responsive rules. Verify on a 390px-wide viewport that the row fits without horizontal scroll.

### Mobile (the bug is mobile-specific — must verify visually)

- The ribbon must not cover the table area where `lastPlay` renders; on the mobile grid (`game-board--mobile`) the table row is `1fr` and the hand/actions sit below — anchor the ribbon to the very bottom so the table stays clear.
- Manual / E2E render check required on a phone-width viewport (iPhone 16 / Chrome DevTools 390x844): confirm the final cards are clearly readable behind the ribbon (the original blur/dim is gone).

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Reconnect / join an already-`COMPLETED` game | Watcher sees `oldStatus !== 'IN_PROGRESS'` → `displayPhase = COMPLETED` directly, skipping the board phase. **Existing behavior preserved.** |
| 2 | Normal win | `status` goes `IN_PROGRESS → COMPLETED`; ribbon shows, `lastPlay` is the winning play, visible on board and on the GameOverView row. |
| 3 | Timer-forced auto-pass ends the game | Same `COMPLETED` path; `lastPlay` is whatever the last real play was; renders normally. |
| 4 | Disconnection forfeit — `lastPlay` may be `null` | Board: `PlayArea` already renders "New Trick — Play any combination" when `lastPlay` is null; the ribbon still shows the winner + Continue (no crash). GameOverView: final-play row is omitted (guarded on truthy + non-empty `cards`). **No crash, no blank box.** |
| 5 | `gameState` null when status becomes `COMPLETED` | Existing `v-if` guards on `gameState` already prevent rendering board/overlay/results; unchanged. |
| 6 | User never clicks Continue (walks away) | Board stays in `SHOW_FINAL_PLAY` indefinitely — acceptable and exactly the "linger" behavior requested. On unmount/navigation, listeners are unbound and socket disconnected as today. No leaked timers (there are none). |
| 7 | Duplicate `COMPLETED` `game:state` events | Watcher only fires on `effectiveStatus` change; repeated same-value events don't re-trigger. No timer to double-fire. |
| 8 | `prefers-reduced-motion` | Ribbon entrance transform disabled; ribbon appears in place. No functional change. |
| 9 | `finalPlay.cards` present but hand-type label unknown | Fall back to rendering cards with the raw `handType.kind` (or no label). Cards are the requirement; label is optional. |

---

## Dependencies

- **LLD 43** (`docs/lld/43-game-over-screen-delay-final-cards.md`) — this LLD modifies the mechanism it introduced. Read it first.
- **Existing code:**
  - `src/frontend/component/game/GameView.vue` — remove timer + progress bar; change overlay to ribbon; add `finalPlay` computed; pass `:final-play` to `GameOverView`.
  - `src/frontend/component/game/GameOverView.vue` — add optional `finalPlay` prop + read-only card row.
  - `src/frontend/component/game-ui/GameCard.vue` — reused unchanged (`size="small"`).
  - `src/frontend/component/game/GameBoard.vue`, `src/frontend/component/game-ui/PlayArea.vue` — unchanged (still render `lastPlay`).
  - `src/shared/big2-types.ts` — `Big2Play`, `Big2PublicState` types reused unchanged.
- **Tests:** `tests/frontend/gameOverTransition.test.ts` must be updated (it currently asserts 4000ms auto-advance — see below).

No new dependencies, no backend/data-model/socket changes.

---

## Test Requirements

### Unit — display phase logic (`tests/frontend/gameOverTransition.test.ts`, UPDATE)

The existing file's helper replicates the watcher with a `setTimeout`/`finalPlayTimerId`. Update the helper to match the new no-timer logic, then:

| # | Test | Verifies | Change |
|---|------|----------|--------|
| 1 | `IN_PROGRESS → COMPLETED` sets `displayPhase` to `SHOW_FINAL_PLAY` | Reveal phase still entered | keep |
| 2 | `SHOW_FINAL_PLAY` does NOT auto-advance over time | No timer; advancing fake timers leaves phase at `SHOW_FINAL_PLAY` | **replaces** old "after 4000ms advances" test |
| 3 | `skipToResults()` from `SHOW_FINAL_PLAY` sets `displayPhase` to `COMPLETED` | Click advances | keep (drop timer-clear assertions) |
| 4 | Reconnect: status starts/goes to `COMPLETED` (from null) → `COMPLETED` directly, no `SHOW_FINAL_PLAY` | Preserved reconnect skip | keep |
| 5 | `CREATED → IN_PROGRESS` → `IN_PROGRESS` | Normal start | keep |
| 6 | `CREATED → COMPLETED` and `null → COMPLETED` go straight to `COMPLETED` | No reveal on non-in-progress origins | keep |

Remove: all `vi.useFakeTimers`/`advanceTimersByTime` assertions tied to the 4000ms behavior, the `finalPlayTimerId` assertions, and the `cleanup clears timer` test (no timer to clear). `vi.useFakeTimers` may remain only if test 2 uses it to prove non-advancement.

### Unit / component — GameOverView final-play row (new, or extend existing GameOverView test if present)

| # | Test | Verifies |
|---|------|----------|
| 1 | Given a `finalPlay` with cards, the final-play row renders one `GameCard` per card | Cards surfaced on results screen |
| 2 | Given `finalPlay = null`, the final-play row is NOT rendered (no empty box) | Forfeit / no-play graceful handling |
| 3 | Given `finalPlay` undefined (prop omitted), no row and no crash | Backward-compatible optional prop |

### Manual / E2E (mobile render — required, bug is mobile-specific)

These cover visual rendering that automated DOM assertions cannot fully verify.

| # | Check | How |
|---|-------|-----|
| 1 | Final cards clearly visible (not dimmed/blurred) behind the ribbon during `SHOW_FINAL_PLAY` | Play a game to completion on phone-width viewport (390x844); confirm `PlayArea` cards are crisp |
| 2 | Ribbon shows winner + "Continue to Results"; clicking it shows `GameOverView` | Desktop and mobile |
| 3 | `GameOverView` shows the final-play card row | After continuing |
| 4 | Disconnection-forfeit ending: board ribbon + results render with no crash/blank when `lastPlay` is null | Force a forfeit ending |
| 5 | Reconnecting to a completed game skips straight to results (no ribbon) | Refresh on a completed `/game/:id` URL |

E2E (Playwright, if added): assert that on game completion `[data-testid="final-play-overlay"]` (ribbon) appears and stays (no auto-advance within a few seconds), and that clicking `[data-testid="continue-to-results"]` reveals `[data-testid="game-over"]`.
