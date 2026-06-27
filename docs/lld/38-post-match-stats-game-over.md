# LLD 38: Post-Match Stats on Game Over Screen

## Scope

### In scope

- Enhance `GameOverView.vue` to display per-game breakdown stats for the current player
- Derive stats from `playHistory` in `Big2PublicState` (already in client state at game completion)
- Add placement badges (gold/silver/bronze/grey) to the score table
- Add a game metadata bar (total turns)
- Add staggered entrance animations for the stats section
- Stats display uses game-type agnostic labels

### Out of scope

- New backend endpoints (all data already available in `PlayerView.gameSpecificPublicState`)
- Lifetime stats page or link to it (issue #40, separate)
- Game duration display (start time not tracked in state; omit for v1)
- Backend changes of any kind
- Rematch functionality
- Stats for spectators

---

## Approach

### Key technical decisions

1. **Client-side derivation only.** All per-game stats are computed from `playHistory` (already in `Big2PublicState` sent via `gameSpecificPublicState`). No new API call, no new backend endpoint.

2. **Game-type agnostic stat keys.** The stats grid uses generic labels: "Plays Made", "Passes", "Tricks Won", "Best Hand". These are computed from `playHistory` entries. When Tonk or other game engines are added, the parent component passes a different derivation function (or the component receives pre-computed stats as a prop). The component itself does not reference "Big2" in labels or logic.

3. **Stats shown only for the current player.** A 2x2 grid below the placement table shows the current player's game performance. This keeps the screen focused and avoids information overload.

4. **Placement badges.** The score table already shows placement; we add visual badges: gold (1st), silver (2nd), bronze (3rd), grey (4th). These are CSS-only, no images.

5. **Staggered entrance animations.** The stats grid cards animate in with a short stagger (CSS `animation-delay`). The placement table appears first, then the stats grid slides/fades in 200ms later.

6. **No "View Lifetime Stats" link.** Explicitly excluded per owner decision.

---

## Interfaces / Types

### New shared type (frontend-only, not in `@shared/`)

```typescript
// src/frontend/component/game/gameOverStats.ts

export interface GameOverStat {
  readonly label: string;
  readonly value: number | string;
}

/**
 * Derive per-game stats for the current player from play history.
 * Game-type agnostic interface -- each game engine has its own derivation.
 */
export function deriveBig2Stats(
  playHistory: readonly { playerId: string; action: string; handType?: string }[],
  currentPlayerId: string,
): GameOverStat[] {
  const myPlays = playHistory.filter(
    (e) => e.playerId === currentPlayerId && e.action === "play",
  );
  const myPasses = playHistory.filter(
    (e) => e.playerId === currentPlayerId && e.action === "pass",
  );

  // "Tricks won" = number of times this player's play was the last before
  // a free play started (i.e., everyone else passed after their play).
  // Approximation: count sequences where this player played and was followed
  // by (N-1) consecutive passes (indicating trick win).
  const tricksWon = countTricksWon(playHistory, currentPlayerId);

  // Best hand = highest handType played (straightFlush > fourOfAKind > fullHouse > straight > pair > single)
  const bestHand = getBestHand(myPlays);

  return [
    { label: "Plays Made", value: myPlays.length },
    { label: "Passes", value: myPasses.length },
    { label: "Tricks Won", value: tricksWon },
    { label: "Best Hand", value: bestHand },
  ];
}
```

### Updated `GameOverView.vue` props

```typescript
// Extended props for GameOverView.vue
const props = defineProps<{
  scores: readonly PlayerScore[];
  winner: string;
  players: readonly PlayerPublicInfo[];
  isGuest: boolean;
  gameId: string;
  playHistory: readonly Big2HistoryEntry[];  // NEW
  currentPlayerId: string;                    // NEW
  totalTurns: number;                         // NEW
}>();
```

### Placement badge mapping

```typescript
// Inside GameOverView.vue computed
const placementBadges = ['gold', 'silver', 'bronze', 'grey'] as const;
type BadgeType = (typeof placementBadges)[number];
```

---

## State Model

### Data flow (no new state -- purely derived)

```
GameView.vue (parent)
  gameState: EnrichedPlayerView
    .gameSpecificPublicState (cast to Big2PublicState)
      .playHistory: Big2HistoryEntry[]  --> passed as prop to GameOverView
    .turnNumber                          --> passed as totalTurns prop
    .you.playerId                        --> passed as currentPlayerId prop

GameOverView.vue
  Receives playHistory, currentPlayerId, totalTurns as props
  Calls deriveBig2Stats(playHistory, currentPlayerId) to compute stats
  Renders stats in a 2x2 grid
```

### No persistence changes

All data is already in memory on the client when the game completes. No backend state changes, no new DB queries, no caching changes.

---

## Frontend Design

### Layout structure

```
+--------------------------------------------+
|           [Winner] wins!                   |
+--------------------------------------------+
|  Player    | Badge | Cards Left | Points   |
|  Alice     |  1st  |     0      |   39     |
|  Bob       |  2nd  |     3      |   -9     |
|  Carol     |  3rd  |     7      |  -15     |
|  Dave      |  4th  |    10      |  -15     |
+--------------------------------------------+
|        Total Turns: 24                     |
+--------------------------------------------+
|  +------------------+  +----------------+  |
|  | Plays Made       |  | Passes         |  |
|  |       12         |  |       4        |  |
|  +------------------+  +----------------+  |
|  +------------------+  +----------------+  |
|  | Tricks Won       |  | Best Hand      |  |
|  |        5         |  | Straight Flush |  |
|  +------------------+  +----------------+  |
+--------------------------------------------+
|   [Rematch(disabled)]   [Back to Home]     |
|   Sign up to save your stats (if guest)    |
+--------------------------------------------+
```

### Placement badges

- 1st: gold circle with crown/star icon (CSS `::before` pseudo-element or unicode)
- 2nd: silver circle
- 3rd: bronze circle
- 4th+: grey circle
- Colors use existing CSS variables where possible (`--gold-accent` for 1st)

### Game metadata bar

- Single line between the score table and stats grid: "Total Turns: N"
- Subdued text color (`--text-muted`), smaller font

### Stats grid

- 2x2 CSS grid
- Each cell: label on top (small, muted), value below (large, prominent)
- Background slightly lighter than panel (`rgba(255,255,255,0.05)`)
- Rounded corners matching existing border-radius
- Stats shown ONLY for the current player (the person viewing the screen)

### Animations

- Score table: fade-in on mount (200ms)
- Metadata bar: fade-in with 100ms delay
- Stats grid: each cell staggers in (delay 0ms, 80ms, 160ms, 240ms) with a slide-up + fade

### Mobile responsive

- Stats grid: 2x2 on mobile (same as desktop, cells just shrink)
- If space is very tight (<320px), stack to 1-column (unlikely scenario)

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | `playHistory` is empty (game ended immediately, e.g. disconnect forfeit) | Show stats grid with all zeros. "Best Hand" shows "--". |
| 2 | Player never played any cards (passed every turn) | Plays Made: 0, Passes: N, Tricks Won: 0, Best Hand: "--" |
| 3 | `gameSpecificPublicState` is null or undefined | Don't render the stats grid or metadata bar. Show only the existing score table. |
| 4 | Game type is not Big2 (future Tonk) | The derivation function is selected by game type in the parent. If no derivation exists for a game type, stats grid is hidden. |
| 5 | 2-player game (only 2 placement badges needed) | Badge array is indexed by position; only gold and silver are shown. |
| 6 | Tie in score (multiple players with same points) | Sort by score descending (existing behavior). Players with the same score get the same positional badge based on their row index (no tie-breaking logic needed for display). |
| 7 | Player was a spectator who became a player mid-game (not currently possible) | Not handled. Current system does not allow spectator-to-player transition. |
| 8 | Very long play history (100+ entries) | Derivation is O(n) filter/reduce over the array. Even with 200 entries this is <1ms. No performance concern. |

---

## Dependencies

- **LLD 4 (Big2 Engine)** -- `Big2PublicState.playHistory` must be populated (already implemented)
- **LLD 7b (Player Stats)** -- `PlayerScore` with `score` field must exist in completed game state (already implemented)
- **Existing code:**
  - `src/frontend/component/game/GameOverView.vue` -- enhanced in place
  - `src/frontend/component/game/GameView.vue` -- passes new props to GameOverView
  - `src/shared/big2-types.ts` -- `Big2HistoryEntry`, `Big2PublicState` types
  - `src/shared/engine-types.ts` -- `PlayerView`, `PlayerScore`

---

## Test Requirements

### Unit tests: stat derivation (`tests/frontend/gameOverStats.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Counts plays correctly | Filter entries by playerId + action "play" |
| 2 | Counts passes correctly | Filter entries by playerId + action "pass" |
| 3 | Counts tricks won correctly | Detects trick-winning sequences (play followed by N-1 passes) |
| 4 | Identifies best hand type | Ranks handTypes and picks the highest |
| 5 | Returns "--" for best hand when no plays made | Empty plays array yields placeholder |
| 6 | Returns all zeros for empty playHistory | Empty input produces zeroed stats |
| 7 | Ignores other players' entries | Only counts entries matching currentPlayerId |

### Unit tests: placement badge logic

| # | Test | What it verifies |
|---|------|------------------|
| 1 | 4-player game assigns gold/silver/bronze/grey | Badge types match position indices |
| 2 | 2-player game assigns gold/silver only | No bronze/grey for positions that don't exist |
| 3 | Badge maps to correct CSS class | Each badge type produces the expected class string |

### Component tests (optional, if Vue Test Utils is in use)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Stats grid renders when playHistory prop provided | 4 stat cells rendered |
| 2 | Stats grid hidden when gameSpecificPublicState is null | No `.game-over__stats` element in DOM |
| 3 | Placement badges render with correct classes | `data-badge="gold"` on first row |
| 4 | Metadata bar shows correct turn count | Text content includes totalTurns value |

### Manual verification

| # | Check | How |
|---|-------|-----|
| 1 | Staggered animation looks smooth | Play a game to completion, observe stats grid entrance |
| 2 | Mobile layout works at 375px width | Chrome DevTools responsive mode |
| 3 | Badge colors are distinguishable | Visual check on game over screen |
