# LLD 107: Miniature cards (final-play reveal + trick history) are too cramped/squished

## Scope

Two independent, surgical, frontend-only CSS/template fixes:

1. **Small-card face** (`GameCard.vue`, `.card--small`): stop the four overlapping glyphs (corner rank+suit + centered rank+suit) from crowding a 28×40px card. Switch the small variant to a single, legible centered rank+suit face and slightly enlarge it (~30×42px).
2. **Big2 trick-history expanded popup** (`TrickPile.vue` `.trick-entry`): make each entry's cards start at a consistent horizontal position regardless of display-name length, by moving the cards onto their own row (fanned/overlapping) below a meta line (name + hand-type).

**Explicitly NOT in scope:**

- No change to `medium`/`large` card rendering (hand, play area, expanded-popup cards stay `size="medium"`).
- No change to game logic, the engine, shared types, or backend.
- No change to the collapsed trick-pile stack geometry (layer offsets/`MAX_LAYERS`); only the card face it renders changes via the shared `.card--small` fix.
- No new component props, events, or state.
- The Tonk joker small face (`.card--small .card__joker-icon`) is unaffected — it already has a small-scoped size and does not use the corner block.

This is purely cosmetic polish. The user's binding decision is **small card Option B** and **alignment Option 3**; these are already approved (mockup on record). Do not re-litigate options.

## Approach

### Decision 1 — Small card: Option B (centered-only face)

The "squished" look comes from four glyphs competing for ~28×40px: the top-left `.card__corner` block (`.card__corner-rank` 11px + `.card__corner-suit` 10px, both **fixed px** that do not scale for the small variant) plus the centered `.card__rank` (~9.6px at `font-size: 0.6rem`) and `.card__suit` (1.2em ≈ 11.5px).

Option B removes the corner block on the small variant and keeps only the enlarged centered rank+suit. Rationale:

- A 28px-wide thumbnail cannot legibly show both a corner index and a centered face; the corner is the redundant element on a card this small (the centered rank+suit already identifies it).
- Hiding the corner via `.card--small`-scoped CSS keeps the change surgical — no template branching, no new props. The corner DOM stays rendered for all sizes but is `display: none` only under `.card--small`.
- Slightly enlarge the small card to **30×42px** and bump the centered glyphs so the face reads cleanly. Medium/large untouched.

Implementation shape (CSS only, in `GameCard.vue`):

- `.card--small` → `width: 30px; height: 42px;` (keep `font-size` for the centered rank; suit stays `1.2em` relative).
- Add `.card--small .card__corner { display: none; }`.
- Optionally nudge the centered rank `font-size` up (e.g. to `0.72rem`) so the enlarged face fills the card; the suit follows via its `1.2em`. Final exact values are the implementer's to tune to match the approved mockup, within "centered-only, ~30×42, no corner."

No JS/template change is required for Decision 1. The `.card__corner` element remains in the template (used by medium/large); we only suppress it for `.card--small`.

### Decision 2 — Trick-history alignment: Option 3 (cards on their own fanned row)

Today `.trick-entry` is a single `flex-wrap` row containing name → hand-type → cards inline, so the cards' start-x shifts with `.trick-entry__name` width (i.e. with display-name length). The fix restructures each play entry into two stacked rows:

- **Row 1 (meta):** display name + hand-type label, inline.
- **Row 2 (cards):** the `medium` cards, on their own line, always starting at the entry's left edge — independent of name length. Cards are **fanned/overlapping** (negative left margin on all but the first card) rather than a flat gapped row (not Option 2) and not a fixed-width name column (not Option 1).

Implementation shape:

- `.trick-entry` becomes `flex-direction: column; align-items: flex-start;` (remove `flex-wrap`/inline row behavior). Keep the existing per-action modifier classes.
- Wrap the existing name + hand-type spans in a meta row (a wrapper `<div class="trick-entry__meta">` with `display: flex; gap`), so they sit together on row 1. The pass case (`trick-entry__pass`) stays on the meta row alongside the name.
- `.trick-entry__cards` stays the card container but is now a full-width second row. Apply a fan: `.trick-entry__cards .card + .card { margin-left: -<overlap>px; }` (replacing the current `gap: 4px`), so cards overlap naturally. Overlap value tuned to the approved mockup (a partial overlap that still reveals each card's centered rank+suit — note expanded-popup cards are `medium`, so the left index is visible on the leading edge).
- Cards remain `size="medium"` in the expanded popup (unchanged).

Because the cards now begin on their own row at the entry's left edge, start-x is constant across entries regardless of name length — satisfying the acceptance criterion.

### Affected usages

| Usage | File / line | Change |
| --- | --- | --- |
| Final-play reveal cards | `GameOverView.vue` ~line 13–18 (`size="small"`) | None to template; inherits the `.card--small` face fix. |
| Collapsed trick-pile thumbnails | `TrickPile.vue` ~line 16 (`size="small"`) | None to template; inherits the `.card--small` face fix. |
| Expanded trick-overlay entry | `TrickPile.vue` ~lines 42–66 / `.trick-entry` ~lines 267–290 | Template: wrap name + hand-type in a `.trick-entry__meta` row; CSS: column layout + fanned cards row. |

## Interfaces / Types

No interface, prop, event, or type changes. `GameCard`'s `size` prop and `TrickPile`'s props (`playHistory`, `trickStartIndex`) are unchanged.

The only template delta is a new presentational wrapper element inside `.trick-entry` (`.trick-entry__meta`) in `TrickPile.vue` to group the name + hand-type onto row 1. No new bindings.

## State Model

No state changes. Both fixes are static CSS plus one structural template wrapper. No reactive data, no persisted state, no in-memory state, no server interaction. `expanded`/`collapse` interaction logic in `TrickPile.vue` is untouched.

## Edge Cases

1. **Single-card final play / single-card trick entry** — centered-only face renders one rank+suit; fan with one card has no overlap margin (the `.card + .card` selector only targets siblings). Renders correctly.
2. **Five-card hands in the expanded popup** (straight / full house / etc.) — the fanned row overlaps so five `medium` cards fit; the panel is `width: min(420px, 100%)` and the entries column scrolls vertically (`overflow-y: auto`). Verify a 5-card fan does not horizontally overflow the panel at 420px and at the mobile full-width breakpoint; if it would, the fan overlap must be large enough to fit five medium cards in the panel width.
3. **Very long display name** — name lives on the meta row (row 1) and may wrap/truncate, but it no longer affects card start-x (row 2 starts at the entry's left edge). This is the core fix.
4. **Pass entries** (`trick-entry--pass`) — have no cards; only the meta row renders ("passed"). The column layout must not leave an empty card row. Since `.trick-entry__cards` is inside the `v-else` (non-pass) branch, no empty row is produced.
5. **Two-digit rank "10"** on the small centered face — the centered `.card__rank` already renders the full rank string; ensure the enlarged small font does not clip "10" at 30px width. Pick a centered font-size that keeps "10♦" within the card.
6. **Red vs black suit color** — the existing `.card.red`/`.card.black` selectors target `.card__rank`/`.card__suit`, which remain present on the small face, so suit color is preserved after hiding the corner.
7. **Mobile breakpoint** (`max-width: 767px`) — collapsed stack already scales to 0.85 via `transform`; the enlarged small card (30×42) scales proportionally. Overlay panel goes full-width; verify the fanned 5-card row still fits.
8. **Reduced motion** — no new animation introduced; existing `prefers-reduced-motion` rules unaffected.

## Frontend Design

**Binding decision: small card Option B + alignment Option 3 (mockup approved; no new mockup step).**

**Small card (Option B):** On `.card--small` only, hide the fixed-px corner rank/suit block (`.card__corner`) and keep ONLY the enlarged centered rank + suit. Target card size ~30×42px (up from 28×40). This removes the four-glyph crowding that produced the "squished" appearance. The corner index that medium/large cards show is intentionally dropped at thumbnail size — a single centered rank+suit is the legible choice for a 30px-wide card. Applies everywhere `size="small"` is used: the game-over Final Play reveal and the collapsed trick-pile thumbnails.

**Trick-history alignment (Option 3):** In the expanded Big2 trick popup, each entry stacks into two rows — a meta line (display name + hand-type label) on top, and the played cards fanned/overlapping below. Cards live on their own full-width row starting at the entry's left edge, so display-name length no longer shifts where the cards begin. The fan (slight negative margin between cards) reads more like a natural hand than a strict gapped grid, addressing the optional "stack more naturally" note. This is explicitly Option 3 — NOT Option 1 (fixed-width name column) and NOT Option 2 (flat non-overlapping row). Expanded-popup cards stay `size="medium"`.

Visual targets:

- Small card: legible, single centered rank+suit, no overlap, ~30×42px, suit color preserved.
- Trick entry: name + type on line 1; cards fanned on line 2; consistent left start across all entries; 5-card hands fit within the 420px panel and the mobile full-width panel.

## Dependencies

- None blocking. Builds on the existing `GameCard.vue` size variants and the LLD 73 final-play row + the existing trick-pile popup. No upstream LLD must change first.
- No backend, shared-type, or migration dependency.

## Test Requirements

The affected logic is presentational CSS plus one structural wrapper; the project's existing frontend tests for these components (`trickPile.test.ts`, `gameOverFinalPlay.test.ts`) are **node-environment logic transcriptions with no DOM mount**, so they assert computed/derivation logic, not CSS. Per testing-principles §10 (bias against manual tests only when an automated check is feasible) and the note that layout/visual correctness genuinely requires visual verification:

**Automated (regression guard):**

- Confirm existing `tests/frontend/trickPile.test.ts` and `tests/frontend/gameOverFinalPlay.test.ts` still pass unchanged — the derivation logic (currentTrick slice, badge count, stack layers, final-play gating/labels) is untouched by this LLD, so these must remain green. No new behavior to assert at the logic layer.
- `npm run build` (vue-tsc type-check) must pass — the new `.trick-entry__meta` wrapper introduces no type changes but the template edit must compile.
- `npm run lint:fix` clean.

**Manual / visual (the substance of this change — cannot be asserted via computed state):**

| # | Check | Expected |
| --- | --- | --- |
| M1 | Game-over Final Play reveal (Big2) | Small cards show a single legible centered rank+suit, no overlapping glyphs, ~30×42px, correct suit color. |
| M2 | Collapsed trick-pile thumbnails during a Big2 game | Same legible small-card face; layered stack geometry and badge unchanged. |
| M3 | Expanded trick popup with players whose names differ greatly in length (e.g. "Al" vs "Maximilian") | Cards in every entry start at the same horizontal position; name length does not shift card start-x. |
| M4 | Expanded trick popup with a 5-card play (straight / full house) | Fanned cards fit within the 420px panel and the mobile full-width panel without horizontal overflow. |
| M5 | Pass entry in the expanded popup | Only the meta row ("passed") shows; no empty card row. |
| M6 | Two-digit rank ("10") on a small card | Rank renders without clipping at 30px width. |
| M7 | Medium/large cards in hand and play area | Unchanged (regression check that the small-scoped CSS did not leak). |

No new automated unit test is warranted because the change adds no new branching logic — it is CSS plus a presentational wrapper. If the implementer adds a DOM-mounting test setup (not currently used in this repo), an optional assertion that `.trick-entry` lays out as a column and that `.card--small .card__corner` is `display:none` would be acceptable but is not required.
