# LLD 141: Player cannot see their own score during a Tonk game

## Scope

Make the local player's own Tonk tally (score) visible at all times during play, on both mobile and desktop, by adding the local player back into `TonkSeatRail` as a distinct self chip.

**Covers:**

- Restoring the local player into `railSeats()` output (currently filtered out) with an `isSelf` flag.
- Rendering the self seat distinctly in `TonkSeatRail.vue`: a distinctly-accented "You" chip (self-identity accent — see Frontend Design token decision), always shown first, with no card-back fan.
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
3. **Self chip is visually distinct:** a dedicated self-identity accent (recommended new `--tonk-self` token — see Frontend Design for the token decision and the rationale against overloading `--tonk-cyan`), name label forced to "You", and no card-back fan (own hand is already shown in the hand zone; a fan for self is redundant and noisy). The `compact`/`wrap` layout rules are unaffected — self simply never draws a fan regardless of `compact`.
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
  readonly isSelf: boolean; // NEW: REQUIRED — true for the local player's row
}
```

**`isSelf` is a REQUIRED (non-optional) field.** `railSeats` is the only production
constructor of `SeatRow` (no `SeatRow` object literals exist elsewhere in the
frontend — confirmed by grep; `TonkSeatRail.vue` consumes the array, it does not
build rows), so making it required costs nothing in production: `railSeats`
always sets it. The only construction sites that must add `isSelf` are the tests
that build `SeatRow` literals directly, if any — as of today there are **none**
(all test call sites go through `railSeats`, which will populate the field), so
no test literal needs the new field. If a future test hand-builds a `SeatRow`,
it must include `isSelf`.

```ts
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
- **AI-affordance suppression on self:** the AiAvatar `v-if` (line 23) and AiBadge `v-if` (line 25) both key on `seat.isAi`. The self row is the human viewing the board, so `isAi` is always falsy for it and no change is strictly required — but the LLD **mandates** that the self chip NEVER shows an AI avatar or AI badge. If the implementation ever composes these `v-if`s, gate them as `seat.isAi && !seat.isSelf` to make the invariant explicit and defensive against a future AI-as-local-player (spectating own AI) scenario.
- **Disconnected-label suppression on self:** the disconnected label `v-if` (lines 40–43) is `!seat.isConnected && !seat.isAi`. The local player is by definition the connected human currently viewing the board, so this is normally a no-op for self. The LLD **mandates** that the self chip NEVER shows a "disconnected" label; gate it as `!seat.isConnected && !seat.isAi && !seat.isSelf` so a transient `isConnected: false` in public state for the local seat cannot render a self "disconnected" affordance.

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
7. **Self chip name collision:** a real player literally named "You" is indistinguishable by label alone, but the `tonk-seat--self` self-accent styling and first-position placement disambiguate. Acceptable.
8. **Self chip never shows an AI badge/avatar:** the local player is the human viewing the board, so `seat.isAi` is expected falsy for the self row and no AI affordance appears. The LLD mandates this as an invariant regardless of the `isAi` value on the self row (see the `TonkSeatRail.vue` gating note): the self chip must never render `AiAvatar` or `AiBadge`. Rationale: even if a future flow lets a user spectate their own AI seat, the "You" chip is an identity marker for the viewer, not an AI label.
9. **Self chip never shows a "disconnected" label:** the disconnected affordance keys on `!seat.isConnected && !seat.isAi`. Because the local player is the connected human currently rendering the board, a "disconnected" label on the self chip would be nonsensical. The LLD mandates suppressing it on self (gate includes `&& !seat.isSelf`), so a transient/stale `isConnected: false` for the local seat in public state cannot surface a self "disconnected" affordance. Opponents' disconnected affordance is unchanged.

## Dependencies

- No dependency on other in-flight LLDs. Builds on the existing LLD 88 (Tonk board) / LLD 99 seat-rail surfaces.
- Adds a dedicated self-accent token (recommended `--tonk-self`) to `src/frontend/styles/game-variables.css` (or, if the owner elects reuse, consumes the existing `--tonk-cyan` — see Frontend Design token decision). The existing `--tonk-near-150` token (`#e09a30`) is reused for the self chip's near-150 warning, same as the rail/panel.
- `isNearLine` already exported from `tonkDisplay.ts`.

## Frontend Design

Owner-selected **Option A**. Add the local player back into `TonkSeatRail` as a distinctly-accented "You" chip.

- **Placement:** self chip is always first in the rail (leftmost on desktop, first in the wrapped flow on mobile), so the player's own score is the first thing in the primary per-player display.
- **Distinct styling — self-accent token:** `tonk-seat--self` uses a distinct self-identity accent to separate it from opponents' neutral chips and from the gold active-turn border. **Token decision:** `--tonk-cyan` (`#3fd0d8`) is already semantically owned by the drawable-discard ring (`game-variables.css:73`, comment `/* drawable-discard ring */`). Reusing it for a second, unrelated meaning (self identity) risks visual ambiguity when the drawable-discard cyan and the self chip are on screen together. **Recommended:** add a dedicated `--tonk-self` token in `game-variables.css` for the self-chip accent (a distinct hue from both `--tonk-cyan` and the gold active border), and bind `tonk-seat--self` to it. If the implementer/owner prefers to reuse `--tonk-cyan` for palette economy, that is acceptable but must be a deliberate choice recorded here — do NOT silently overload the drawable-discard token. The name label reads "You" instead of the display name. No card-back fan for self (the player's actual hand is already rendered in the hand zone; a fan would be redundant).
- **Tally emphasis:** the self chip keeps the same `tonk-seat__tally` pill so the score reads identically to opponents', with the near-150 warning tint (`--tonk-near-150`) applied when `isNearLine(tally)` is true — consistent with how the rail/panel already surface the loss-line warning.
- **Single-surface fix:** because the rail is the only per-player UI on mobile, this one change satisfies both mobile and desktop. Do NOT add the self score to the desktop `TonkTallyPanel` or the mobile log drawer.
- **Constraint:** own-tally value reads `tonkState.tallies[myPlayerIndex]` (server-authoritative public state) — no client-side score recomputation. Opponents' chips and tallies are unchanged.

Mockup note: this is a small additive change to an existing, already-approved rail component (adds one distinctly-styled chip). If the reviewer requires a fresh HTML mockup before finalizing per the frontend workflow, generate one showing the self-accented "You" chip in first position at both breakpoints (desktop rail + <=767px wrapped rail) and in the near-150 state.

## Test Requirements

**Test-impact accounting (MUST update — the new `railSeats` behavior breaks existing assertions):**

Changing `railSeats` from "filter out self" to "include self, marked `isSelf`, sorted first" is a behavior change. Three existing test suites across TWO files call `railSeats`; every assertion below must be reconciled or the build reds. This is the complete list of `railSeats` call sites in `tests/` — the implementer must not treat `tonkDisplay.test.ts` as the only affected file.

1. **`tests/frontend/tonkDisplay.test.ts`**
   - **MUST CHANGE** — `it("railSeats omits the local player and carries seat index + tally")` (~lines 113–117). It asserts `seats.map((s) => s.seatIndex)` equals `[1, 2]` and `tally` equals `[20, 30]` for `myPlayerIndex = 0`. Under the new design self (seat 0) is included and sorted first, so the result is `[0, 1, 2]` / `[10, 20, 30]`. Replace this test with the new contract (see the "replaces/updated" list below): self included, marked `isSelf: true`, first.
   - **MUST CHANGE** — the 8-player assertion `expect(railSeats(players(8), new Array(8).fill(0), 0)).toHaveLength(7)` (~line 140). Now returns **8** rows.
   - **VERIFY / likely OK** — spectator test `railSeats(..., -1)` (~lines 119–122) asserts `toHaveLength(3)`; still 3 (no self match). Add an assertion that no row has `isSelf === true`.
   - **VERIFY** — disconnected-flag test (~lines 143–149) uses `myPlayerIndex = 0` and looks up `seats.find((s) => s.seatIndex === 1)`. Seat 1 is still present and still non-self, so this `.find` survives; but self (seat 0) is now included, so re-confirm the lookup is by `seatIndex` (it is) and stays green.

2. **`tests/frontend/aiBadgeRendering.test.ts`**
   - **MUST CHANGE / REMOVE** — `it("railSeats filters out myPlayerIndex seat as before")` (lines 159–162): `expect(seats.some((s) => s.seatIndex === myPlayerIndex)).toBe(false)`. This hard-codes the OLD filter behavior and will FAIL under the new design (self IS now included). Delete this test or invert it to assert the self seat is now present and marked `isSelf: true`.
   - **VERIFY / OK** — the other assertions in the `describe("railSeats — isAi propagation into SeatRow")` block (lines 122–184) use `myPlayerIndex = 0` (Alice) and query by `playerId` (`ai:uuid-1`, `user-2`) or iterate all rows checking `isAi`. Alice is now included as a self row, but she is not AI, so the `isAi`-propagation assertions are unaffected. The `.find(by playerId)` lookups for the non-self AI/human seats survive unchanged.

3. **`tests/frontend/aiAvatarRendering.test.ts`**
   - **VERIFY / OK** — `describe("TonkSeatRail — railSeats propagates isAi for AiAvatar")` (lines 261–306) uses `myPlayerIndex = 0` and asserts via `.find(by playerId)` or `forEach(isAi falsy)`. The newly-included self row (Alice, non-AI) does not change any `isAi` assertion, so these stay green. No edit required, but the implementer must run this file to confirm (the LLD's earlier blanket "opponent chips render unchanged" claim is scoped to these `isAi` assertions, which survive; it is NOT a claim that no other `railSeats` test changed).

**Unit — `tests/frontend/tonkDisplay.test.ts` — new/updated `railSeats` contract:**

- `railSeats` now INCLUDES the local player and marks it `isSelf: true`, sorted first (this is the replacement for the deleted "omits the local player" test).
- Non-self rows retain ascending seat order and `isSelf: false`.
- Self row carries `tallies[myPlayerIndex]` as its tally (assert the own score value is present, e.g. seat 0 tally `10` when `myPlayerIndex = 0`).
- Spectator render (`myPlayerIndex === -1`): still returns all players, none marked `isSelf`.
- 8-player game now returns 8 rows (was 7).
- `tallies` shorter than `players` → self row tally falls back to 0.
- Disconnected flag still carried for the correct seat (self now included; re-verify by-`seatIndex` indexing).

**Component — `tests/frontend/` (TonkSeatRail render, mirroring existing `aiBadgeRendering`/`aiAvatarRendering` style):**

- Self chip renders with the `tonk-seat--self` class and label "You".
- Self chip does NOT render a `tonk-seat-fan` even when `compact` is false.
- Self chip renders the own tally value via `tonk-seat-tally`.
- Near-150: self tally >= threshold applies the warning modifier.
- Self chip never renders `AiAvatar`/`ai-badge` even if the self row's `isAi` were truthy (invariant from Edge Case 8).
- Self chip never renders the "disconnected" label even when the self row's `isConnected` is false (invariant from Edge Case 9).
- Opponent (non-self) chips render unchanged — name from `displayName`, tally, fan when not compact, AI badge/avatar when `isAi`, disconnected label when applicable — regression guard scoped to non-self rows only.

**Manual / visual (acceptance-gated, cannot be fully asserted in unit):**

- On a mobile viewport (<=767px), during an in-progress Tonk game, the local player's tally is visible in the seat rail. (Explicit acceptance criterion.)
- Desktop: self chip appears first and is visually distinct from opponents and from the active-turn glow.
