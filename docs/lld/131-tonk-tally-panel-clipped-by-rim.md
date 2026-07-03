# LLD 131: Round/score tallies clipped off the side of the game screen

## Scope

Fixes a desktop-only layout defect where the right-hand side panel of the game
board is drawn flush against the viewport edge and its rightmost ~12px is
covered by the decorative wood-rim border. On the Tonk board this clips the
right-pinned score values in `TonkTallyPanel`; the identical structural gap
exists on the Big2 board (right column is `GameLog`).

**Covers:**

- CSS-only change to `.tonk-board__log` in `TonkBoard.vue` and
  `.game-board__log` in `GameBoard.vue` so the right-column content clears the
  12px `::after` rim on desktop.

**Does NOT cover:**

- Any game logic, state, engine, or component-script changes (none needed).
- The mobile layout: the side panel is `display: none` at `<= 767px`; the
  seat-rail tallies (`TonkSeatRail`) are a separate component and unaffected.
- The tally values, ranking, progress-bar math, or `TonkTallyPanel` internals —
  the panel renders correctly; it is only positioned under the rim.
- Reworking the rim into a real grid gutter / padded board container. That is a
  larger refactor (see Approach — Rejected options) and is out of scope.

## Approach

**Confirmed root cause.** Both boards are `position: fixed; inset: 0` grids.
The wood rim is painted by an `::after` pseudo-element at `inset: 0;
z-index: 100` with a `border: 12px solid`. Grid children sit at `z-index: 1`
with no right-side inset, so the right `log` column reaches the viewport edge
and its outer 12px is rendered underneath the rim overlay. In `TonkTallyPanel`
the row grid right-pins `.tonk-tally-row__score` (`grid-template-columns:
18px 1fr auto`) and the row container uses only 8px padding
(`.tonk-tally-panel__rows { padding: 8px }`), which is narrower than the 12px
rim, so the rightmost score digits are the part covered.

**Chosen fix (Option A).** Add `padding-right: 12px` (matching the rim width) to
the right-column grid cell in each board:

- `.tonk-board__log` in `TonkBoard.vue`
- `.game-board__log` in `GameBoard.vue`

This insets the panel content off the right edge so it clears the rim, without
touching the panel components themselves. The padding is applied to the grid
cell (the `log` area), not the panel, so the panel keeps filling the (now
inset) cell and its `border-left` / background still render correctly.

**Why this over alternatives:**

- Minimal, CSS-only, matches the existing hardcoded `12px` rim convention
  already present in both files (`border: 12px solid`).
- Fixes both boards consistently at the structural layer (the grid cell), so
  any future right-column content is also protected — not just the tally
  scores.
- The panel components (`TonkTallyPanel`, `GameLog`) need no change, keeping the
  blast radius to two style rules.

**Rejected options:**

- _Inset the whole board grid (padding on `.tonk-board` / `.game-board`)._
  Cleaner conceptually but the rim `::after` is `inset: 0` and the felt
  background fills the padded area oddly; it would also shift the top/left/
  bottom content and risk regressing the opponents row, hand, and actions
  areas. Larger blast radius for no extra benefit here.
- _Bump `TonkTallyPanel`'s inner padding from 8px to 12px+._ Fixes Tonk only,
  leaves Big2's `GameLog` still clipped, and does not address the structural
  cause (content still reaches the viewport edge, only the text is nudged in).

**Consistency note.** This branch also carries the fix for issue #150, which
touches `TonkBoard.vue`. Per the selection guidance, both edits to
`TonkBoard.vue` should land as one coherent change so the file is not touched
twice.

## Interfaces / Types

None. No TypeScript, props, events, or shared types change. This is a
presentational CSS-only fix.

## State Model

None. No component state, reactive data, or persisted state is involved. The
change is static layout styling only.

## Frontend Design

**Decision: Option A** — add `padding-right: 12px` to the right-hand grid
column of each board so tally/log content clears the wood rim.

No HTML mockup is required for this LLD. The change is a sub-pixel-scale
cosmetic correction (nudging content ~12px inward) to an already-approved
layout, not a new visual direction — it makes existing content fully visible
rather than changing how anything looks. The frontend-architect mockup gate
applies to new/changed visual direction; restoring clipped content to full
visibility does not alter the design language.

**Exact edits (illustrative — implementer follows existing style):**

`TonkBoard.vue`:

```css
.tonk-board__log {
  grid-area: log;
  padding-right: 12px; /* clear the 12px ::after wood rim */
}
```

`GameBoard.vue`:

```css
.game-board__log {
  grid-area: log;
  padding-right: 12px; /* clear the 12px ::after wood rim */
}
```

**Constraints:**

- Match the existing hardcoded `12px` rim value used in each file's `::after`
  rule. Do not introduce a new shared variable for this (keep the change
  surgical; the rim width is already a literal in these files).
- Do NOT add the padding inside the mobile `@media (max-width: 767px)` block or
  in a way that affects it. The mobile rules set `.*__log { display: none }`, so
  a desktop-scope `padding-right` on the base rule is inert on mobile (the cell
  is not rendered). No mobile override is needed.
- The panel's `border-left` and `background` must remain flush against the
  panel's own left edge — apply padding to the grid cell (`__log`), never inside
  the panel component, so the panel's visual boundary is unchanged and only its
  right edge moves inward.

## Edge Cases

1. **3-digit tallies (e.g. 149).** The right-pinned `.tonk-tally-row__score`
   (`auto` column, tabular-nums) is the widest at 3 digits. After the inset, the
   last digit must be fully clear of the rim. This is the primary acceptance
   case — verify at 1024 / 1280 / 1440px widths.
2. **Progress bars.** `.tonk-tally-row__bar` spans the full row width
   (`grid-area: bar` across all three columns). After the inset the bar's right
   end must also clear the rim, not just the score text.
3. **Big2 right column (`GameLog`).** `GameLog` content right edge must clear
   the rim too; the same `padding-right` on `.game-board__log` covers it.
4. **Mobile (`<= 767px`).** `.*__log` is `display: none`; the side panel is not
   rendered and the seat-rail tallies are unaffected. The desktop
   `padding-right` must not leak into or regress the mobile layout — confirm the
   mobile board and rim are unchanged.
5. **Long player names.** `.tonk-tally-row__name` is `1fr` with
   `text-overflow: ellipsis`; narrowing the panel content by 12px slightly
   reduces the name column width but must not cause overflow (ellipsis still
   truncates). Verify a long name still truncates cleanly and does not push the
   score off.
6. **Panel background/border-left.** The panel fills the grid cell; with
   `padding-right` on the cell, verify the panel background does not leave an
   unpainted 12px gutter that looks visually wrong against the rim (the rim
   itself is opaque wood, so a small felt/panel gutter behind it is acceptable —
   confirm it reads as intended, not as a rendering seam).

## Dependencies

- Existing components as of this branch: `TonkBoard.vue`,
  `GameBoard.vue`, `TonkTallyPanel.vue`, `GameLog.vue`. No new dependencies.
- Coordinate with the #150 edit to `TonkBoard.vue` on this branch — land both as
  one coherent change to avoid touching the file twice.
- No backend, engine, schema, or shared-type dependencies.

## Test Requirements

Per `docs/testing-principles.md` §10 heuristic 6 ("bias against manual tests,
but layout/responsiveness genuinely requires visual verification"), this is a
pure-CSS layout fix with no computed state or logic to assert, so it is verified
manually.

**Manual (desktop, primary):**

| # | Setup | Expected |
|---|-------|----------|
| M1 | Tonk in-progress game, desktop viewport at 1024px | Full tally panel visible; rightmost digit of a 3-digit tally (e.g. 149) fully readable, not under the rim |
| M2 | Same, at 1280px and 1440px | Same — last digit and progress-bar right end clear the rim at all three widths |
| M3 | Big2 in-progress game, desktop | `GameLog` right column content is not clipped by the rim |
| M4 | Resize below 767px (or load on mobile) for both boards | Side panel remains hidden (`display: none`); seat-rail tallies unaffected; no layout regression, rim unchanged |
| M5 | Tonk game with a long player name | Name still truncates with ellipsis; score stays right-pinned and fully visible |

**Automated:** None required. No engine, logic, or component-script behavior
changes; there is nothing new to assert in unit or integration tests, and the
project's test strategy explicitly skips UI/layout tests until game logic is the
concern (which it is not here). `npm run build` and `npm run lint:fix` must pass
with zero errors as the mechanical gate.
