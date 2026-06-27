# LLD 45: Show Previous Played Cards on the Table

## Scope

**Covers:** Displaying the last 2-3 plays (before the current `lastPlay`) directly in the Big2 PlayArea so players can see recent trick context without opening the log drawer.

**Does NOT cover:**
- Backend changes (data already available in `Big2PublicState.playHistory`)
- Changes to the GameLog component or drawer behavior
- Other game types (Tonk will have its own table component)
- New composables or state management

## Approach

**Frontend-only change.** The `Big2PublicState.playHistory` array already contains the full play history. The implementation slices recent entries and renders them in `PlayArea.vue` as visually secondary card groups.

**Visual direction:** Option B from the approved mockup (scattered/layered). Previous plays appear to the left of the current play, faded and scaled down, with slight rotation to evoke cards left on the felt. The current `lastPlay` remains centered and prominent.

**Key decisions:**
1. Render previous plays inline within `PlayArea.vue` rather than extracting a new component — keeps the change minimal.
2. Reuse the existing `GameCard` component with `size="small"` for previous plays.
3. Show at most 2 previous plays (excluding passes) to avoid clutter. Passes are indicated with text only, not card renders.
4. On mobile (max-width: 767px), hide previous plays entirely — the table area is too constrained. Mobile users use the existing log drawer.
5. Use CSS transitions for opacity/transform so plays animate into position when state updates.

## Frontend Design

### Layout Change to PlayArea.vue

The PlayArea template gains a "play history" container that renders alongside the existing current-play section. Layout uses `position: relative` on the parent with previous plays absolutely positioned to the left of center.

```
.play-area (existing, no layout change to parent)
  TurnTimer (existing)
  .play-area__history-zone (NEW — holds all plays)
    .play-area__previous-play.play-area__previous-play--older (oldest, leftmost)
    .play-area__previous-play.play-area__previous-play--recent (more recent)
    .play-area__current-play (existing lastPlay content, moved here)
  .play-area__free (existing, shown when no lastPlay)
```

### Props Changes

`PlayArea.vue` receives one new prop:

```typescript
playHistory: readonly Big2HistoryEntry[];
```

Passed from `GameBoard.vue` which already has access to `big2State?.playHistory`.

### Computed: `recentPlays`

```typescript
// Filter to only "play" actions (not passes), exclude the most recent
// entry (which corresponds to lastPlay), take the last 2.
const recentPlays = computed(() => {
  const plays = props.playHistory.filter(e => e.action === 'play');
  if (plays.length <= 1) return [];
  // Last entry in plays corresponds to lastPlay; show the 2 before it
  return plays.slice(-3, -1);
});
```

### CSS Styling for Previous Plays

```css
.play-area__history-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  position: relative;
}

.play-area__previous-play {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  transition: opacity 0.4s ease, transform 0.4s ease;
}

.play-area__previous-play--older {
  transform: rotate(-3deg) scale(0.65);
  opacity: 0.35;
  margin-right: -4px;
}

.play-area__previous-play--recent {
  transform: rotate(-1.5deg) scale(0.78);
  opacity: 0.6;
  margin-right: 8px;
}

/* Hide on mobile */
@media (max-width: 767px) {
  .play-area__previous-play { display: none; }
}
```

### Card Rendering

Previous plays use `<GameCard :card="card" size="small" />` (existing 28x40px size). The current play continues using `size="medium"`.

### Pass Handling

Passes between plays are not rendered as cards. Only actual card plays appear in the history zone. This avoids visual noise and keeps the display compact.

### Data Flow

```
GameView.vue
  -> GameBoard.vue (has big2State via computed)
    -> PlayArea.vue (receives playHistory prop + existing lastPlay prop)
      -> computes recentPlays (last 2 card-plays before current)
      -> renders GameCard with size="small" for each
```

## Interfaces / Types

No new types needed. All data structures already exist:

- `Big2HistoryEntry` (from `@shared/big2-types.ts`) — has `playerId`, `displayName`, `action`, `cards?`, `handType?`
- `Big2PublicState.playHistory` — already sent to client via `gameSpecificPublicState`

### Prop Addition to PlayArea.vue

```typescript
// PlayArea.vue props (add playHistory)
defineProps<{
  lastPlay: Big2PublicState["lastPlay"] | null;
  isMyTurn: boolean;
  currentPlayerName: string;
  players: readonly PlayerPublicInfo[];
  turnDeadline: number | null;
  totalSeconds: number;
  playHistory: readonly Big2HistoryEntry[];  // NEW
}>();
```

### GameBoard.vue Binding Change

```html
<PlayArea
  :last-play="big2State?.lastPlay ?? null"
  :play-history="big2State?.playHistory ?? []"
  ...existing props...
/>
```

## State Model

No new state. All data is derived from `Big2PublicState.playHistory` which is already:
- Computed by `Big2Engine.getPlayerView()` on every state change
- Sent to client via Socket.IO `game:state` events
- Available in `GameBoard.vue` as `big2State.playHistory`

The `recentPlays` computed property is a pure derivation — no caching or persistence needed.

## Edge Cases

1. **Empty history (game just started):** `recentPlays` returns `[]`. Only the current play or "New Trick" message shows. No visual change from current behavior.

2. **Only one play in history:** `recentPlays` returns `[]`. The single play is the current `lastPlay` — shown centered as today.

3. **New trick (lastPlay is null after all pass):** Previous plays from the ended trick are still in `playHistory`. Show the last 2 card-plays from the ended trick as faded context. This helps players see what was played in the trick that just concluded.

4. **Five-card hands in previous plays:** A straight/full house shows 5 small cards (5 x 28px = 140px plus gaps). At scale(0.65), this renders at ~91px wide — fits comfortably.

5. **Rapid successive plays:** CSS transitions handle the animation. No debouncing needed — Vue's reactivity + CSS transitions produce the correct result regardless of timing.

6. **Mobile viewport (375px):** Previous plays are hidden via `display: none` at max-width: 767px. The table area remains uncluttered. Users use the existing log drawer toggle.

7. **Spectator view:** Spectators receive the same `Big2PublicState.playHistory` via `getSpectatorView()`. The feature works identically for spectators.

## Dependencies

- `GameCard.vue` with `size="small"` — already exists (28x40px)
- `Big2PublicState.playHistory` — already populated by the engine and sent to clients
- CSS variables from `game-variables.css` — already imported in PlayArea

No upstream LLDs required. This is a leaf-level frontend enhancement.

## Test Requirements

### Unit Tests (Vitest + Vue Test Utils)

1. **`recentPlays` computed returns empty when history has 0-1 plays**
2. **`recentPlays` computed returns last 2 card-plays (filters out passes)**
3. **`recentPlays` computed caps at 2 entries even with long history**
4. **Previous play cards render with `size="small"` prop**
5. **Previous plays are not rendered when `lastPlay` is null and history is empty**

### Visual/Layout Verification (Manual)

| Scenario | Check |
|----------|-------|
| Desktop, 3+ plays in history | 2 previous plays visible to the left, faded and rotated |
| Desktop, current play is a new trick | Previous trick's last 2 plays shown faded |
| Mobile 375px width | Previous plays hidden, only current play or "New Trick" text visible |
| 5-card hand in previous play | Cards fit without overflow |
| Rapid plays (watch mode) | Transitions are smooth, no layout jumps |

### Not Tested

- Backend engine logic (unchanged)
- Log drawer behavior (unchanged)
- WebSocket transport (unchanged)
