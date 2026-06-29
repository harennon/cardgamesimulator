# LLD 92: Tonk board rendering (read-only board: hand, discard pile, stock, tallies)

**Status:** SUPERSEDED — duplicate of **LLD 88** (`docs/lld/88-tonk-board-rendering.md`), which was reviewed, approved, and **already implemented and merged** (commit `3b0af93`, PR #98). Parent: #41 (Tonk end-to-end), order 3 of 5. Depends on: engine #57 / **LLD 69** (merged PR #80) and **LLD 65** (signed off 2026-06-28).

> ⚠️ **Read this first — do not re-implement.** Issue #92 and the earlier issue covered by **LLD 88** describe the **same feature**: the read-only Tonk board (`TonkBoard.vue`) dispatched by `gameType`, rendering hand + discard + drawable-discard + stock + opponent counts + turn/phase + tallies + log, with the user-approved **A1 + B1 + compact-seats-at-6** direction (joker as icon, mobile compact tallies). That work has already shipped: `src/frontend/component/game/TonkBoard.vue` and its sub-components (`TonkPiles`, `TonkPhaseBanner`, `TonkSeatRail`, `TonkTallyPanel`, `TonkLog`, `TonkHand`, `tonkDisplay.ts`), the additive `GameCard` joker support, the `GameView.vue` dispatch + ribbon gate, the `game-variables.css` Tonk tokens, and the frontend tests (`tests/frontend/tonk*.test.ts`) all exist on this branch.
>
> **The canonical, authoritative design document is LLD 88.** This file (LLD 92) exists only because the issue requested an LLD numbered 92 at this path; it records the reconciliation and the approved frontend direction for traceability, then defers entirely to LLD 88. **No new code should be written from this LLD.** If acceptance gaps are found, fix them against LLD 88, not by forking a parallel design here.

---

## Scope

This LLD covers **nothing new**. It documents that the read-only Tonk board described by issue #92 is identical in intent and acceptance criteria to LLD 88, which is already implemented and merged.

What the shipped implementation (per LLD 88) covers, mapped to issue #92's acceptance criteria:

| Issue #92 acceptance criterion | Where satisfied (shipped) |
| --- | --- |
| `TonkBoard.vue` renders hand, discard top + `drawableDiscard` indicator, face-down stock + count, opponent counts, turn+phase indicator, tallies, log from PlayerView | `src/frontend/component/game/TonkBoard.vue` + `TonkPiles`/`TonkPhaseBanner`/`TonkSeatRail`/`TonkTallyPanel`/`TonkHand`/`TonkLog` |
| `GameView.vue` dispatches `TonkBoard` for `gameType === "tonk"` without affecting Big2 | `GameView.vue` board-dispatch `v-if="gameState.gameType === 'tonk'"` + Big2-gated final-play ribbon (LLD 88 decision 1) |
| Renders correctly for 3–8 players (seating usable at 8) | `TonkSeatRail.vue` — compact at ≥6, wrap at ≥7 (LLD 88 §Frontend Design) |
| Spectator view shows public info only (no hands, no stock contents) | Component contract: reads only public `TonkPublicState` + `you.hand` for the local player; hand zone hidden when `myPlayerIndex === -1` (LLD 88 E11) |
| Rendering driven entirely by server-provided view data; no client-side rule computation | `tonkState` narrows `gameSpecificPublicState` to `TonkPublicState`; `validActions` used for the indicator only, never rules (LLD 88 §State Model) |
| Usable on mobile viewport | Single-column grid override + compact tallies in seat pills + log FAB drawer (LLD 88 §Frontend Design mobile) |

**Explicitly NOT covered** (same exclusions as LLD 88): no action controls (#59), no melds/spreads (do not exist), no client-side rule computation, no Tonk branches in generic WebSocket/state plumbing, no `deckRoundsTarget` lobby control (#60), no spectator entry-route wiring, no `GameOverView` Tonk-wording changes.

---

## Approach

The approach is **exactly LLD 88's** — there is no alternative design to present, because the design is already chosen, approved, and built. Summary of the load-bearing decisions (authoritative text in LLD 88 §Approach):

1. **Dispatch at the component layer only.** `GameView.vue` selects `<TonkBoard>` vs `<GameBoard>` on `gameState.gameType`; the generic `useGameState`/`useGameActions`/`useSocket` plumbing is untouched. The Big2 final-play ribbon is additionally gated to `gameType === "big2"` so it never renders over a completing Tonk match's transient `SHOW_FINAL_PLAY` step (LLD 88 decision 1b / E8).
2. **TonkBoard reuses Big2's four-zone grid skeleton** (opponents / table / hand / log / actions) and felt/rim styling for visual consistency; the `table` zone renders Tonk piles + phase banner instead of Big2's `PlayArea`, and the `actions` zone holds only a read-only status line (no buttons).
3. **Reuse shared primitives only where the prop contract already accepts the Tonk shape; otherwise fork a thin Tonk-only component that copies the CSS/behavior.** `GameCard` is reused (extended additively for jokers). `PlayerHand`/`GameLog`/`OpponentRow` are **not** reused directly — they are Big2-typed (`Card[]` keyed on `rank/suit`; `Big2HistoryEntry`; `PlayerPublicInfo` card-fan) — so `TonkHand`/`TonkLog`/`TonkSeatRail` copy their visual language without coupling shared Big2 contracts to Tonk types.
4. **All display data comes from `TonkPublicState`** (`src/shared/tonk-types.ts`); the joker stays Tonk-local (`TonkCard = Card | TonkJoker`), never widening shared `Card`/`Rank`.
5. **The 150 loss-line is presentational only** — a display gauge computed from `tallies[i]` and the constant `150`; the board never decides game-over.

---

## Interfaces / Types

No shared types change beyond the additive `GameCard` joker prop (`card: Card | TonkJoker`), which is already shipped. All Tonk view types already exist in `src/shared/tonk-types.ts`. Full interface listings for `TonkBoard`, `TonkPiles`, `TonkPhaseBanner`, `TonkSeatRail`, `TonkTallyPanel`, `TonkHand`, `TonkLog`, and the `GameView.vue` edits are in **LLD 88 §Interfaces / Types** and match the as-built components on this branch. They are not duplicated here to avoid drift.

---

## State Model

Identical to LLD 88 §State Model:

- **No new client state.** `TonkBoard` is a pure function of `props.gameState` (an `EnrichedPlayerView`); the only local reactive state is UI-only (`isMobile`, `logDrawerOpen`).
- **Server-authoritative, information-hidden by construction.** The board reads only public fields (`stockCount`, `discardTop`, `drawableDiscard`, `tallies`, `log`, opponent `cardCount`) plus `you.hand` for the local player. Hidden info is absent from the props, so it cannot leak (architecture-principles #2). No rule computation (architecture-principles #1).
- **Spectator-safe contract:** `TonkPublicState` is identical between `getPlayerView`/`getSpectatorView`; the hand zone renders nothing when there is no local hand (`myPlayerIndex === -1`).
- **Nothing persisted** — presentation only.

---

## Frontend Design

> **Approved direction (user, 2026-06-29): A1 + B1 + compact seats at 6.** Notes: "joke is better as an icon"; "mobile compact tallies look good!". This matches the direction recorded in and implemented per LLD 88. Mockup reference: the approved `tonk-board-rendering.html`.

- **Center piles — A1 (separate drawable-discard slot).** The `table` zone renders, left→right: **Stock** (one face-down `GameCard` + count label from `stockCount`, contents never rendered); **Discard** (the live pile top `discardTop`, labeled with who just played it, `×N` multiplier badge when `lastDiscardCount > 1`, empty placeholder when `discardTop === null`); **Drawable** (the turn-start `drawableDiscard` snapshot lifted out **beside** the pile, **cyan-ringed** via `--tonk-cyan` and labeled `drawable`, with a dimmed "no card to draw" placeholder when `null`). The two-card display (live top vs. drawable snapshot) is the one genuinely new visual problem: Tonk discards **before** drawing, so the live top is the current player's own just-played card — NOT what a drawer may take — and the cyan drawable slot makes the legally-drawable card unambiguous (LLD 65 §3.3/§6.1).
- **Phase banner & active-seat tag — B1.** `TonkPhaseBanner` (top of `table`) names the active player + a color-coded phase chip (discard = warm `--tonk-phase-discard`, draw = cool `--tonk-phase-draw`) + the trick number. The active seat in `TonkSeatRail` repeats a short phase tag colored to match and reuses Big2's pulse-dot affordance.
- **Seats — compact at ≥6, usable at 8 (3–8 supported).** `TonkSeatRail` shows a card-back fan + count + tally chip below 6 players; at ≥6 it drops the fan (count + tally chip only); at ≥7 it wraps to two rows. Usable at the max of 8.
- **Tallies & 150 loss-line.** `TonkTallyPanel` (right side) ranks all players by tally ascending (lower is better) with a thin progress bar toward 150 and a `--tonk-near-150` warning tint near the line; shows the current trick number.
- **Joker as icon.** `GameCard` renders a `TonkJoker` as a centered icon glyph (no rank/suit, never the literal text "Joker").
- **Mobile (≤767px).** Single-column stack; **tallies fold into the seat pills** (the right tally panel is hidden in portrait — "mobile compact tallies look good!"); center keeps stock + discard + drawable in one row scaled down; hand scrolls horizontally; log behind a FAB-opened teleported drawer (Esc to close, `prefers-reduced-motion` respected); trick number abbreviates to `T<n>`.
- All Tonk colors are tokens in `src/frontend/styles/game-variables.css` (`--tonk-cyan`, `--tonk-phase-discard`, `--tonk-phase-draw`, `--tonk-near-150`); everything else reuses existing felt/rim/text/gold tokens.

Full per-component layout detail is in **LLD 88 §Frontend Design** (authoritative; matches the shipped components).

---

## Edge Cases

Enumerated and handled in **LLD 88 §Edge Cases (E1–E14)** and verified by the shipped tests. The key ones:

- **Tonk completion / transient `SHOW_FINAL_PLAY` (E8):** a completing Tonk match makes the generic `IN_PROGRESS → COMPLETED` transition and sets `state.winner` (lowest tally, display-only), so `GameView.vue` briefly enters `SHOW_FINAL_PLAY`. The Big2 "wins!" ribbon is gated to `gameType === "big2"` so it never renders over the Tonk board (which would be semantically wrong for Tonk's loss-centric model and would read Big2-only `lastPlay`/`finalPlay`); the `COMPLETED` branch then routes to `GameOverView`.
- Empty discard / null drawable (trick 1), multi-discard `×N` badge, joker in any pile position, 3-player min and 8-player max seating, disconnected opponent, tally ≥150 mid-render (no client-side game-over), spectator-style render with no local hand, tie tallies, `prefers-reduced-motion`, long names at ≥6 — all handled per LLD 88.

---

## Dependencies

All implemented (this is a documentation reconciliation; nothing to build):

| Dependency | Status |
| --- | --- |
| `src/shared/tonk-types.ts` (`TonkPublicState`, `TonkCard`, `TonkJoker`, `isJoker`, `TonkLogEntry`) | Implemented (#57 / LLD 69) |
| `src/shared/engine-types.ts`, `src/shared/socket-events.ts` (`EnrichedPlayerView`, `PlayerView`, `GameType`) | Implemented |
| `src/frontend/component/game/TonkBoard.vue` + `game-ui/Tonk*.vue` + `tonkDisplay.ts` | **Implemented (LLD 88, PR #98)** |
| `src/frontend/component/game/GameView.vue` (dispatch + ribbon gate) | **Implemented (LLD 88)** |
| `src/frontend/component/game-ui/GameCard.vue` (additive joker support) | **Implemented (LLD 88)** |
| `src/frontend/styles/game-variables.css` (Tonk tokens) | **Implemented (LLD 88)** |

**Out of scope / separately tracked:** action controls (#59), `deckRoundsTarget` lobby control (#60), spectator entry-route wiring (pre-existing gap), `GameOverView` Tonk wording/ordering (follow-up flagged in LLD 88 §Dependencies).

---

## Test Requirements

The required tests are specified in **LLD 88 §Test Requirements** and are already implemented under `tests/frontend/` (`tonkBoard.test.ts`, `tonkBoardDispatch.test.ts`, `tonkDisplay.test.ts`, `tonkGameCard.test.ts`, `tonkHand.test.ts`). No new test work is required by this LLD. Categories covered:

- **Unit — dispatch (`GameView.vue`):** `tonk` → `TonkBoard`, `big2` → `GameBoard`; the transient `SHOW_FINAL_PLAY` regression guard (Tonk: ribbon absent; Big2 control: ribbon present); a completing Tonk game reaches `GameOverView` without the Big2 ribbon.
- **Unit — `TonkBoard` rendering from `TonkPublicState`:** hand, discard top, cyan drawable slot, face-down stock + count, opponent counts, trick number, tallies; null/empty placeholders; `×N` multi-discard badge.
- **Unit — phase/turn indicator (B1):** chip text + phase-color class per `turnPhase`; "Your turn" vs "<name>'s turn"; pulse-dot on the active seat only.
- **Unit — seats (3–8, compact/wrap):** fan + tally below 6; compact (no fan) at 6; wrap at 7–8; disconnected affordance.
- **Unit — tally panel & 150 line:** ascending rank, progress `min(tally/150, 1)`, `near-150` class, no client game-over.
- **Unit — joker icon:** joker renders the icon element, never the text "Joker"; Big2 cards unregressed.
- **Unit — `TonkLog`:** discard entry shows cards + count; draw entry shows source but **never** the drawn card (negative assertion); trick-result summary.
- **Security / information-hiding:** negative assertions that no opponent hand card and no stock card appears in the rendered output; spectator contract with `myPlayerIndex === -1`.
- **Manual (visual/responsive only):** center-pile legibility + cyan ring on desktop, phase-chip color distinctness, 8-player 2-row wrap, mobile single-column stack with folded tallies + log FAB, reduced-motion.
