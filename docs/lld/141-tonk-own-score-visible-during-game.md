# LLD 141: Player cannot see their own score during a Tonk game

## Scope

Make the local player's own Tonk tally (score) visible at all times during play, on both mobile and desktop, by adding the local player back into `TonkSeatRail` as a distinct self chip.

**Covers:**

- Restoring the local player into `railSeats()` output (currently filtered out) with an `isSelf` flag.
- Rendering the self seat distinctly in `TonkSeatRail.vue`: a cyan "You" chip, always shown first, with no card-back fan.
- Surfacing the near-150 warning state on the self chip, consistent with the tally panel / rail.

**Does NOT cover:**

- Any backend, shared-type, or server-state change. The tally value already ships in `TonkPublicState.tallies` (public state).
- Changes to `TonkTallyPanel.vue` (desktop side panel) or the mobile log drawer — the fix is delivered solely through the seat rail, which is the only per-player UI rendered on mobile.
- Any change to opponents' seat rendering, tallies, or ordering.
- Big2 (this is a Tonk-only surface).

## Approach

**Chosen: Option A — add the local player back into `TonkSeatRail` as a distinct self chip.**

Rationale: `TonkSeatRail` is the single per-player surface that renders on both mobile and desktop (the desktop-only `TonkTallyPanel` lives in the `tonk-board__log` grid area, which is `display: none` on mobile, and the mobile drawer renders only `TonkLog`). Fixing the rail fixes both breakpoints with one change and keeps a single source of per-player display truth. Solving via the tally panel or drawer would leave mobile broken or duplicate the surface.

Key decisions:

1. **`railSeats()` stops filtering out `myPlayerIndex`.** Instead it marks that row `isSelf: true` and sorts the self row first. Every value (name, tally, cardCount, connection) continues to come from the same public-state inputs already passed in — no new data source, no client-side score computation. The own tally is `tallies[myPlayerIndex]`, the same array the panel and opponent chips read (architecture-principles §1/§2: clients are thin renderers of server-authoritative state).
2. **Spectator render (`myPlayerIndex === -1`) is unchanged** — no row matches self, so all seats render as today (E11 contract preserved).
3. **Self chip is visually distinct:** cyan accent (`--tonk-cyan`), name label forced to "You", and no card-back fan (own hand is already shown in the hand zone; a fan for self is redundant and noisy). The `compact`/`wrap` layout rules are unaffected — self simply never draws a fan regardless of `compact`.
4. **Near-150 warning** reuses the existing `isNearLine()` threshold so the self chip highlights identically to how the tally panel already warns.
5. **Turn/phase/timer affordances** (active border, phase tag, pulse, `OpponentTimer`) continue to key off `seatIndex === currentPlayerIndex`, so they light up correctly when it is the local player's turn — no special-casing needed.

## Interfaces / Types

`tonkDisplay.ts` — extend `SeatRow` and change `railSeats` ordering/filter:

```ts
export interface SeatRow {
  readonly playerId: string;
  readonly displayName: string;
  readonly cardCount: number;
  readonly isConnected: boolean;
  readonly isAi?: boolean;
  readonly seatIndex: number;
  readonly tally: number;
  readonly isSelf: boolean; // NEW: true for the local player's row
}

/**
 * Seats rendered by the rail: EVERY player, including the local player.
 * The local player's row is marked isSelf and sorted first; all others keep
 * ascending seat order. Spectator render (myPlayerIndex === -1) => no isSelf row.
 */
export function railSeats(
  players: readonly PlayerPublicInfo[],
  tallies: readonly number[],
  myPlayerIndex: number,
): SeatRow[];
```

Behavior:

- Map all players to rows (as today), setting `isSelf = seatIndex === myPlayerIndex`.
- No `.filter` removing self.
- Sort so the `isSelf` row is first; remaining rows stay in ascending `seatIndex` order (stable). Suggested comparator: `self first, else by seatIndex asc`.

`TonkSeatRail.vue` — no new props. Template gains:

- `class="tonk-seat--self"` bound when `seat.isSelf`.
- Fan `v-if` changes from `!compact` to `!compact && !seat.isSelf`.
- Name renders `"You"` when `seat.isSelf`, else `seat.displayName`.
- Near-150 class on the self (and only needs to exist on self for this fix, but applying the existing `isNearLine` check to the self tally is sufficient): bind a `tonk-seat__tally--near` modifier via `isNearLine(seat.tally)`.

Import `isNearLine` from `./tonkDisplay` (already exported).

## State Model

Fully client-side / presentational. No persisted or in-memory server state changes.

- Input: `TonkPublicState.tallies` (already broadcast to every client in public state) + `players` + `myPlayerIndex` (derived in `TonkBoard` from `you.playerId`).
- `railSeats()` is a pure transform of those inputs → `SeatRow[]`.
- The self tally value is `tallies[myPlayerIndex]`; it re-renders reactively when the server pushes new public state (same reactivity path as every other chip and the tally panel). No recomputation, no local accumulation.

`TonkBoard.vue` already passes `:tallies="tonkState.tallies"` and `:my-player-index="myPlayerIndex"` to the rail, so no prop wiring changes.

## Edge Cases

1. **Spectator render (`myPlayerIndex === -1`):** no row is self; rail renders all players in seat order exactly as today. (Preserves the E11 contract that `TonkBoard` uses when there is no local hand.)
2. **Local player is the active player:** self chip shows the active border, phase tag, pulse, and `OpponentTimer` — all already keyed on `currentPlayerIndex`, no change needed.
3. **Self tally near/at 150:** self chip shows the near-150 warning via `isNearLine(seat.tally)`, matching the tally panel.
4. **Mobile viewport (<=767px):** self chip renders in the wrapped row layout; fan already hidden on mobile for all seats, so `!seat.isSelf` fan suppression is a no-op there but keeps desktop consistent. Acceptance requires the self tally be visible here.
5. **Compact rail (6+) / wrapping rail (7+):** self chip participates; it just never draws a fan. Adding self means the rail now renders N chips instead of N-1 (e.g. 8-player game → 8 chips). Confirm wrap layout still fits; the self chip is smaller (no fan) so this does not worsen the widest case.
6. **`tallies` shorter than `players` (defensive):** existing `tallies[seatIndex] ?? 0` fallback still applies to the self row; shows 0 rather than crashing.
7. **Self chip name collision:** a real player literally named "You" is indistinguishable by label alone, but the cyan `tonk-seat--self` styling and first-position placement disambiguate. Acceptable.

## Dependencies

- No dependency on other in-flight LLDs. Builds on the existing LLD 88 (Tonk board) / LLD 99 seat-rail surfaces.
- Requires the `--tonk-cyan` token already present in `src/frontend/styles/game-variables.css`.
- `isNearLine` already exported from `tonkDisplay.ts`.

## Frontend Design

Owner-selected **Option A**. Add the local player back into `TonkSeatRail` as a distinct cyan "You" chip.

- **Placement:** self chip is always first in the rail (leftmost on desktop, first in the wrapped flow on mobile), so the player's own score is the first thing in the primary per-player display.
- **Distinct styling:** `tonk-seat--self` uses a cyan border/accent (`--tonk-cyan`) to separate it from opponents' neutral chips and from the gold active-turn border. The name label reads "You" instead of the display name. No card-back fan for self (the player's actual hand is already rendered in the hand zone; a fan would be redundant).
- **Tally emphasis:** the self chip keeps the same `tonk-seat__tally` pill so the score reads identically to opponents', with the near-150 warning tint (`--tonk-near-150`) applied when `isNearLine(tally)` is true — consistent with how the rail/panel already surface the loss-line warning.
- **Single-surface fix:** because the rail is the only per-player UI on mobile, this one change satisfies both mobile and desktop. Do NOT add the self score to the desktop `TonkTallyPanel` or the mobile log drawer.
- **Constraint:** own-tally value reads `tonkState.tallies[myPlayerIndex]` (server-authoritative public state) — no client-side score recomputation. Opponents' chips and tallies are unchanged.

Mockup note: this is a small additive change to an existing, already-approved rail component (adds one distinctly-styled chip). If the reviewer requires a fresh HTML mockup before finalizing per the frontend workflow, generate one showing the cyan "You" chip in first position at both breakpoints (desktop rail + <=767px wrapped rail) and in the near-150 state.

## Test Requirements

**Unit — `tests/frontend/tonkDisplay.test.ts` (pure `railSeats`):**

- `railSeats` now INCLUDES the local player and marks it `isSelf: true`, sorted first (replaces the current "omits the local player" test — that assertion must be updated, not kept).
- Non-self rows retain ascending seat order and `isSelf: false`.
- Self row carries `tallies[myPlayerIndex]` as its tally (assert the own score value is present).
- Spectator render (`myPlayerIndex === -1`): still returns all players, none marked `isSelf` (existing test stays green).
- 8-player game now returns 8 rows (was 7) — update the length assertion.
- `tallies` shorter than `players` → self row tally falls back to 0.
- Disconnected flag still carried for the correct seat (existing test; self is now included so re-verify indexing).

**Component — `tests/frontend/` (TonkSeatRail render, mirroring existing `aiBadgeRendering`/`aiAvatarRendering` style):**

- Self chip renders with the `tonk-seat--self` class and label "You".
- Self chip does NOT render a `tonk-seat-fan` even when `compact` is false.
- Self chip renders the own tally value via `tonk-seat-tally`.
- Near-150: self tally >= threshold applies the warning modifier.
- Opponent chips render unchanged (name, tally, fan when not compact) — regression guard.

**Manual / visual (acceptance-gated, cannot be fully asserted in unit):**

- On a mobile viewport (<=767px), during an in-progress Tonk game, the local player's tally is visible in the seat rail. (Explicit acceptance criterion.)
- Desktop: self chip appears first and is visually distinct from opponents and from the active-turn glow.
