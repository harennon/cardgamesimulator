# LLD 143: Round/score tallies clipped off the side of the game screen

## Scope

Fixes the desktop layout defect where the right-hand side panel (Tonk `TonkTallyPanel`, Big2 `GameLog`) is drawn flush to the viewport edge and its rightmost ~12px — including the right-pinned Tonk score digits — is covered by the decorative wood-rim `::after` overlay.

**Covers:**
- `.tonk-board` and `.game-board` grid containers: inset all grid content clear of the 12px wood rim.
- Consistent treatment across both boards (Tonk symptom is clipped tallies; Big2 has the same structural gap on its log column).
- Preserving the mobile layout (rim is 4px, right column is `display: none` ≤767px).

**Does NOT cover:**
- Any change to `TonkTallyPanel.vue` internals (grid columns, row padding, score alignment). The panel is correct; the board just doesn't reserve space for the rim.
- Big2 `GameLog` internals.
- Mobile seat-rail tallies (`TonkSeatRail`) — unaffected.
- The wood-rim visual itself (thickness, gradient, felt bleed).
- Any backend / game-engine / socket behavior — this is a pure CSS change.

## Approach

**Root cause.** Both boards are `position: fixed; inset: 0` grids with a 12px wood rim painted as an `::after` pseudo-element at `inset: 0; z-index: 100`. Grid children sit at `z-index: 1`, i.e. *under* the rim. The grid has no padding, so every child reaches the viewport edge and its outer 12px is rendered beneath the rim. On Big2 the right column is a play log (padded, so clipping is invisible); on Tonk the right column right-pins the score value with only 8px inner padding — narrower than the 12px rim — so the last digits get covered.

**Decision — Option B (whole-grid inset), the approved design.** Add a single `padding` equal to the rim width to the grid *container* (`.tonk-board`, `.game-board`), so every grid child clears the rim on all four sides. The felt `background` and `::before`/`::after` still fill the full `inset: 0` box, so the felt continues to bleed under the rim and the table look is preserved.

Rejected alternative — per-column `padding-right: 12px` on `.tonk-board__log` / `.game-board__log` (this was PR #158 / an earlier option): superseded by the user's 2026-07-04 decision. It only fixes the right edge for the log column, leaves the other three edges of every child still tucked under the rim, and must be repeated per board/column. The whole-grid inset is one rule per board, fixes all four edges uniformly, and is the least surprising.

**Supersede PR #158.** Do NOT resume PR #158's `padding-right` approach. Close that PR or overwrite its branch. Branch from current `origin/main` (PR #159 / LLD 134 is already merged there and set the actions row to `grid-template-rows: 80px 1fr 220px auto`; this horizontal rim-inset fix is orthogonal and stays fully relevant).

**Token.** Introduce a shared CSS variable `--board-rim-inset: 12px` in `game-variables.css`, defined to equal the desktop rim width, and reference it from both board containers. This keeps the inset and the rim width conceptually linked in one place (the rim border itself stays a literal `12px` in each `::after`, matching current code; the token documents the coupling and gives the mobile override a single symbol to reset).

**Mobile.** The desktop rim is 12px; the mobile rim is `--mobile-rim-width: 4px`. Under the `@media (max-width: 767px)` block the container padding must be reset to the mobile rim width (or `0`, since the right column is hidden and the remaining columns already look correct on mobile today). Reset to `var(--mobile-rim-width)` to keep behavior identical to the current mobile layout intent and avoid any content shift. Mobile must remain visually unchanged.

## Interfaces / Types

No TypeScript changes. Pure CSS. Affected selectors:

```css
/* src/frontend/styles/game-variables.css — :root */
--board-rim-inset: 12px;   /* desktop wood-rim thickness; keeps grid content clear of ::after */

/* src/frontend/component/game/TonkBoard.vue — .tonk-board (scoped) */
.tonk-board { /* ...existing grid... */ padding: var(--board-rim-inset); }
/* @media (max-width:767px) .tonk-board--mobile { padding: var(--mobile-rim-width); } */

/* src/frontend/component/game/GameBoard.vue — .game-board (scoped) */
.game-board { /* ...existing grid... */ padding: var(--board-rim-inset); }
/* @media (max-width:767px) .game-board--mobile { padding: var(--mobile-rim-width); } */
```

Notes for the implementer:
- `padding` on a grid container reduces the content box the tracks are laid into; `grid-template-columns: 1fr 280px` still resolves — the `1fr` (table/hand) column absorbs the 24px horizontal loss, the fixed 280px side panel is unchanged. Verify no track overflow at 1024px.
- Keep the `::before` (felt texture) and `::after` (rim) at `inset: 0` — they intentionally paint the full box under/over the padded content, so the felt still bleeds edge-to-edge.
- The `.tonk-log-drawer` / `.log-drawer` mobile drawers are `position: fixed` outside the grid (teleported to body) and are not affected by container padding.

## State Model

No state. No persisted or in-memory data. This is a static presentational layout fix in scoped component CSS plus one design token. No reactive props, composables, or socket payloads change.

## Edge Cases

1. **1024px narrow desktop** — 24px of horizontal padding removed from tracks. The 280px panel is fixed; the `1fr` table/hand column shrinks by 24px. Verify the table content (piles / play area) and hand row still fit without horizontal overflow or new scrollbars.
2. **3-digit tally (e.g. 149)** — the primary acceptance case: the right-pinned `.tonk-tally-row__score` last digit must be fully visible, not under the rim, at 1024 / 1280 / 1440px.
3. **Boundary at 767/768px** — at exactly 768px the desktop 12px inset applies; at 767px the mobile 4px inset applies. Confirm no clipping at the low end of desktop and no layout jump crossing the breakpoint.
4. **Mobile ≤767px** — right column stays `display: none`; padding resets to `--mobile-rim-width`. Mobile board must look pixel-identical to today (seat-rail tallies, hand, actions unaffected).
5. **Bottom `actions` row** — it spans both columns (`actions actions`) and now clears the bottom rim too (previously flush). Confirm LLD 134's `auto`-height actions row still renders correctly with the added bottom padding and is not clipped by the rim.
6. **Big2 log column** — with the inset, `GameLog` no longer tucks under the right rim. Confirm no visible gap/regression in the Big2 log panel.
7. **Loading state** — `.tonk-board--loading` uses the same class; padding is harmless on the centered "Loading…" flex box.

## Dependencies

- **LLD 88 / 92** — Tonk board rendering (defines `.tonk-board` grid + rim).
- **LLD 134 (merged, PR #159)** — changed the actions row to `auto`; branch from `origin/main` which contains it. Interacts only via Edge Case 5.
- **LLD 141 (merged, PR #162)** — added self-score display; no interaction, informational.
- Supersedes the per-column approach of **PR #158**; that PR must be closed / its branch overwritten, not resumed.
- No new libraries, migrations, or backend dependencies.

## Frontend Design

**Approved design: Option B — whole-grid inset (NOT per-column padding).** User decision 2026-07-04 00:31 (this reassigned option letters vs the earlier round; the earlier per-column `padding-right` on the log column is now superseded).

- Add `padding: var(--board-rim-inset)` (12px, desktop rim thickness) to **both** `.tonk-board` and `.game-board` grid containers so every grid child — all four edges — clears the wood-rim `::after` overlay.
- Define `--board-rim-inset: 12px` once in `game-variables.css :root`.
- The felt `radial-gradient` background and the `::before`/`::after` pseudo-elements stay at `inset: 0`, so felt still bleeds under the rim and the casino-table look is preserved. Only the interactive/text content is inset.
- **Mobile preserved:** in each board's `@media (max-width: 767px)` block, reset the container padding to `var(--mobile-rim-width)` (4px). The tally/log column remains `display: none`; the mobile rim stays 4px; mobile must be visually untouched.
- No changes to `TonkTallyPanel.vue` or `GameLog.vue`.

Visual acceptance: the last digit of a 3-digit tally (149) is fully readable at 1024 / 1280 / 1440px on the Tonk board, and the Big2 log panel is not clipped, with no mobile regression. (Mockups already re-based onto LLD 134's `auto` actions row; the horizontal rim-inset direction is unaffected by that vertical change.)

## Test Requirements

This is a scoped-CSS layout change. jsdom does not apply scoped `<style>` rules or compute geometry, so automated assertions on computed padding/pixel positions are not meaningful here — per testing-principles §"bias against manual tests", layout/responsiveness is the sanctioned manual exception. Keep automated coverage to what is verifiable and avoid brittle style-string assertions.

**Regression guard (automated, existing suites):**
- `npm run build` (vue-tsc + vite) passes with zero errors.
- `npm run lint:fix` clean.
- Existing `tests/frontend/tonkBoard.test.ts`, `tonkBoardDispatch.test.ts`, and `gameBoardMobile.test.ts` still pass unchanged — confirms the component logic (mobile ref, drawer, dispatch) is untouched by the CSS edit.

**Manual visual verification (required — the acceptance criteria):**

| # | Setup | Assertion |
|---|-------|-----------|
| M1 | Tonk in-progress game, desktop @ 1280px, a player tally = 149 | Last digit of `149` in `.tonk-tally-row__score` is fully visible, not under the wood rim on the right edge. |
| M2 | Repeat M1 @ 1024px and @ 1440px | Same — 3-digit tally fully readable at all three widths. |
| M3 | Same Tonk game | Progress bars (`.tonk-tally-row__bar-fill`) reach their intended width without the right end clipped by the rim; header/footer text not clipped. |
| M4 | Big2 in-progress game, desktop @ 1280px | `GameLog` right edge is not clipped by the wood rim; no new gap or misalignment. |
| M5 | Both boards @ ≤767px (e.g. 375px) | Layout pixel-identical to pre-change: side panel hidden, hand/actions/seat-rail unaffected, rim is 4px, no content shift. |
| M6 | Tonk desktop, observe bottom actions row | Actions row clears the bottom rim (LLD 134 `auto` height) and is not clipped. |
| M7 | Cross the 767/768px breakpoint by resizing | No layout jump/flash; desktop shows 12px inset, mobile shows 4px. |

Use `docker compose up` (or `npm run dev`) and a real browser at the specified widths; `?debug` overlay is not needed for this layout check.
