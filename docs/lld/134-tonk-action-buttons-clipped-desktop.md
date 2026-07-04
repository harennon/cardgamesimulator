# LLD 134: Action/discard buttons cut off at bottom of game screen on PC

**Status:** Draft for review. Bug fix from triage-feedback (2 registered-user reports). Frontend-only CSS-layout fix; no engine/server/schema/transport changes.

Turn-blocking bug: on desktop, during a Tonk turn, the primary action buttons (Discard / Draw stock / Take discard / Call TONK) render below the viewport bottom and are clipped, so the active player cannot see or click them — they cannot take their turn.

---

## Scope

### Covers

- Fixing the **Tonk desktop board grid** so the action panel (`TonkActionPanel.vue`) is fully visible and clickable during the local player's turn, at all common desktop viewport heights.
- The fix must accommodate the panel's **natural height** across all its states:
  - not-your-turn: single-line turn pill,
  - your turn: two-line (phase-stepper row + button row),
  - your turn with `actionError`: three-line (error row + stepper row + button row).

### Explicitly does NOT cover

- **No change to Big2** (`GameBoard.vue` grid or `ActionPanel.vue`). Big2's panel is a single ~44px button row that fits the existing `64px` row; it stays byte-for-byte unchanged (acceptance criterion).
- **No change to the mobile path** (`@media (max-width: 767px)`). The mobile Tonk grid uses `--mobile-actions-height` and is not affected by this bug; leave it untouched (regression constraint).
- **No change to `TonkActionPanel.vue` internals** (padding, gaps, button `min-height`, stepper, error row). The panel's natural height is correct; only the grid track that contains it is wrong. Touching the panel would be a larger, riskier change for no benefit.
- **No engine, server, WebSocket, API, DB, or migration changes.** This is purely `TonkBoard.vue` scoped-CSS.
- No new component, prop, emit, type, or composable.

---

## Approach

### Root cause

`TonkBoard.vue` (desktop) defines a fixed grid:

```css
.tonk-board {
  grid-template-rows: 80px 1fr 220px 64px; /* line ~256 */
  overflow: hidden;                        /* line ~269 */
}
```

The `actions` row is a fixed **64px**. On the local player's turn `TonkActionPanel` is a vertical flex column whose natural height is roughly:

```
padding 12 (top) + stepper/turn-pill row ~24 + gap 10 + button row min-height 44 + padding 12 (bottom) ≈ 102px
```

and taller when `actionError` is present (adds the error row + a 10px gap). The panel is `justify-content: center; height: 100%` inside a 64px track, so its content overflows below the fixed track; the board's `overflow: hidden` then clips everything below the viewport bottom — including the entire button row. This is a **fixed-height mismatch**, not viewport-dependent: it clips at 768px, 900px, and 1080px alike (confirmed in the mockup's BUG frames). Big2 is unaffected because its panel is a single ~44px row that fits 64px.

Introduced with the Tonk actions UI (LLD 99, commit `4c40082`). Later mobile-only fixes (LLD 105/108) did not touch the desktop actions-row height, so it is not already fixed.

### Chosen fix — Fix B: auto-height actions row (mockup `#fixB`, marked RECOMMENDED)

Change **only the Tonk desktop grid's last row** from a fixed `64px` to `auto`, so the row is always exactly as tall as the panel's content — one line, two lines, or two lines + error — with no magic number to maintain and no clipping at any viewport height or any future third line. The `1fr` `table` row absorbs the height the actions row takes.

```css
.tonk-board {
  /* was: grid-template-rows: 80px 1fr 220px 64px; */
  grid-template-rows: 80px 1fr 220px auto;
}
```

Because the panel stops stretching to fill a fixed track, its content (`justify-content: center; height: 100%`) sits tighter and more intentional against the bottom rim instead of floating in dead space. `overflow: hidden` on the board is **kept** — it is what contains the felt texture/rim overlays and the 1fr table; with an `auto` actions row nothing overflows, so it no longer clips the panel.

**Why Fix B over the alternatives (both in the mockup):**

- **Fix A — taller fixed row (`--tonk-actions-height`, e.g. 116px):** smallest, most explicit diff, but reintroduces a magic constant that must be re-tuned if the panel ever grows a line, and unconditionally steals ~52px from the `1fr` table row even when the panel is a single-line pill. Auto-height gives the table that space back when the panel is short.
- **Fix C — floating overlay panel (`position: absolute`):** most flexible but overlaps the hand/table, needs a z-index and a reserved bottom margin, and departs from the footer-bar convention shared with Big2. Larger structural change than warranted for a clipping bug.

Fix B removes the mismatch at the root, tolerates the error row and any future panel line without a re-tuned constant, keeps the Big2/footer convention, and is the smallest conceptual change that cannot silently regress.

### Guard: keep the 1fr table row shrinkable

A grid `1fr` track has an implicit `min-height: auto` (min-content), which can prevent it from yielding space to an `auto` sibling if the table content is tall. On desktop the table content (`TonkPhaseBanner` + `TonkPiles`, one card row) is small, so at 768px it comfortably yields the ~102–130px the panel needs. To make the `1fr` row's ability to shrink explicit and robust (and to mirror the existing mobile rule `.tonk-board--mobile .tonk-board__table { min-height: 0; }`), add `min-height: 0` to the desktop `.tonk-board__table` rule. This is a safe, well-scoped addition that guarantees the auto actions row is never squeezed at the shortest supported height.

---

## Interfaces / Types

None. No component API, prop, emit, type, token, or composable changes. The entire change is scoped CSS in `src/frontend/component/game/TonkBoard.vue`:

1. `.tonk-board` desktop rule: `grid-template-rows: 80px 1fr 220px 64px` → `80px 1fr 220px auto`.
2. `.tonk-board__table` desktop rule: add `min-height: 0` (shrink guard).

`TonkActionPanel.vue`, `ActionPanel.vue`, `GameBoard.vue`, and `game-variables.css` are **not** modified.

---

## State Model

No state change. This is a static layout fix. The panel's rendered height already varies by the existing reactive inputs it consumes (`isMyTurn`, `turnPhase`, `actionError`) — those flows are unchanged (LLD 99 §State Model). The only difference is that the containing grid row now sizes to that content instead of clipping it.

---

## Frontend Design

**Approved direction: Fix B — auto-height actions row.** Mockup: repo-root `tonk-action-buttons-clipped-desktop.html`, section `#fixB` (labeled RECOMMENDED). It reconciles with this LLD exactly: the Tonk desktop grid's last track becomes `auto`, Big2's grid stays `64px`, and the mobile `--mobile-actions-height` rules are untouched. The panel's own layout (stepper, turn pill, buttons, error row, tokens, fonts) is unchanged from LLD 99.

Panel height by state (all now fully visible; the actions row grows to match):

| Panel state | Rows in panel | Approx. natural height |
| --- | --- | --- |
| Not your turn | turn pill only | ~48px |
| Your turn (discard or draw) | stepper + button row | ~102px |
| Your turn + `actionError` | error + stepper + button row | ~130–150px |

The mockup's `#fixB` frames render exactly these three states — discard phase (two-line), draw phase (two-line), and not-your-turn (single-line pill) — at 768px and 900px, all uncut. The error-row (three-line) worst case is proven fittable in the mockup's Fix A frame at 768px; under Fix B the same content is content-sized, so it fits at least as well.

Visual outcome vs. today: on a short (768px) screen the felt/table area is ~40px shorter during the active player's turn (the actions row is taller than 64px) and taller when it is not their turn (the pill-only row is shorter than 64px). This is the intended, acceptable trade-off for a footer at the screen edge (mockup comparison table, Fix B "Cons").

---

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| E1 | Not your turn (single-line pill) | Actions row = ~48px (auto); table `1fr` reclaims the extra space vs. the old 64px. No clip. Mockup `#fixB` 900px frame. |
| E2 | Your turn, discard phase (two-line) | Row auto-grows to ~102px; buttons fully visible/clickable. Mockup `#fixB` 768px discard frame. |
| E3 | Your turn, draw phase (two-line) | Same as E2; Draw stock + Take discard visible. Mockup `#fixB` 768px draw frame. |
| E4 | Your turn + `actionError` (three-line) | Row auto-grows to fit error + stepper + buttons; all visible. This is the acceptance-criterion "error-message row" case. |
| E5 | Shortest supported desktop (768px) with error row | `1fr` table row yields space (`min-height: 0` guard). Table content (banner + piles) is small enough to shrink; panel is never clipped. Verify manually at 768px with an error present. |
| E6 | 900px / 1080px viewport | Ample space; `1fr` table absorbs the auto row trivially. Verify no clip and no layout jump. |
| E7 | Big2 board | Untouched — still `grid-template-rows: 80px 1fr 220px 64px`, single-row panel fits. Regression guard. |
| E8 | Mobile (`max-width: 767px`), Tonk | The mobile media block overrides `grid-template-rows` with `--mobile-actions-height`; the desktop `auto` value does not apply. Unchanged behavior. Regression guard. |
| E9 | Spectator-style render (`myPlayerIndex === -1`) | Panel renders the disabled/not-your-turn shell (short); auto row sizes to it. No clip. |
| E10 | Two-button row wrap on a narrow-but-desktop width | Panel already uses `flex-wrap` on `.tonk-action-panel__buttons`; if buttons wrap to two rows the auto grid track grows to fit them — Fix B removes the clip in this case too (fixed 64px would not have). |

---

## Dependencies

- **LLD 99 (Tonk Player Actions UI)** — defines `TonkActionPanel.vue` (the two-line panel) and the `tonk-board__actions` footer slot this fix contains. Consumed as-is; not modified.
- **LLD 88 (Tonk board rendering)** — defines the `TonkBoard.vue` grid being edited.
- No dependency on any backend, engine, migration, or transport work. Nothing must be built first; all touched files exist in this worktree.

---

## Test Requirements

Per testing-principles §5 / decision heuristics: this is a pure visual/responsive-layout fix with no computed state, no engine logic, and no DOM-conditional logic that a unit test could meaningfully assert beyond restating the CSS. The existing LLD 99 tests already cover the panel's button-derivation and turn-flow logic and are unaffected. So the verification here is primarily **manual visual** at the specified viewport heights, plus a build/lint gate.

### Automated (gate — no new test files)

- `npm run build` passes with zero errors (the change is CSS-only; this confirms no accidental template/script edit).
- `npm run lint:fix` clean.
- Existing frontend test suite (`tests/frontend/tonk*.test.ts`) still passes — regression guard confirming the panel and board component logic is untouched.

### Manual (visual/UX — the substance of this fix)

Run `npm run dev`, open a Tonk game, and, at browser viewport **heights 768px, 900px, and 1080px** (desktop widths ≥768px), on the **local player's own turn**, verify:

1. **Discard phase (two-line):** phase stepper + Discard (and Call TONK when the gate is open) are fully visible and clickable; nothing is cut off by the bottom edge.
2. **Draw phase (two-line):** Draw stock + Take discard fully visible and clickable.
3. **Error row (three-line):** trigger a rejected discard (e.g. a mixed-rank selection); confirm the error row + stepper + buttons are all visible and the buttons remain clickable.
4. **Not your turn (single-line):** the turn pill renders; the felt/table area reclaims the freed space; no clip, no overlap with the hand row.
5. **No layout jump / overlap:** the actions row growing/shrinking between states does not push the hand row off-screen or overlap the wood rim.

### Regression (manual)

6. **Big2 desktop:** action panel (Play / Pass) is visually unchanged and its row height is still 64px.
7. **Mobile Tonk (`max-width: 767px`):** actions row still uses `--mobile-actions-height`; buttons ≥44px and tappable; behavior identical to before.
