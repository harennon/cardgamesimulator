# LLD 108: Discard pile goes off-screen on mobile when playing a full house

## Scope

**Covers:** The mobile rendering of the Big2 current play (`PlayArea.vue`) and its adjacent trick pile (`TrickPile.vue`) so that a 5-card combination (full house, straight, flush, four-of-a-kind, straight flush) is fully visible inside the clipped mobile table area at viewport widths down to 320px.

Two coupled structural changes:

1. **Decouple the trick pile from the played-cards composition on mobile.** Today the pile is `position: absolute; left: -64px` relative to the centered play, so a wide play drags pile + play past the right edge and `overflow: clip` on `.game-board--mobile` truncates it. Pin the pile to a fixed corner of the felt (bottom-left of `.play-area`) on mobile so it no longer participates in the horizontal extent of the play.
2. **Width-cap the played row and let cards flex-shrink to share the available width** (Option C, approved 2026-06-30 "Frontend decision: Option C"). Pure CSS, single centered row, preserve aspect ratio, no transform/scale, no JS.

Plus one supporting change carried by the frontend decision note:

3. **Render the collapsed trick pile as a single static icon after the first play** instead of a live card stack, so the pile is a constant size regardless of trick depth. This simplifies fixed-corner placement and removes the current `MAX_LAYERS=4` layered rendering as the pile's collapsed representation.

**Does NOT cover:**
- Any game-engine, server, shared-type, or data change. This is client rendering only — no `getPlayerView`, no `validActions`, no persistence touched.
- The expanded trick overlay (`.trick-overlay`) content/behavior — it stays as-is (full per-play card list). Only the *collapsed* pile representation changes.
- Desktop (`>=768px`) layout — must render byte-for-byte identically to today.
- Tonk board (`TonkPiles.vue`) — unaffected; it uses its own discard rendering.
- The player's own hand row (`PlayerHand.vue`) — already horizontally scrollable, out of scope.

## Approach

### Root cause (confirmed)

- Played row: `.play-area__card-row { display: flex; gap: 4px; }` with no `flex-wrap`/`max-width`. Each `GameCard size="medium"` is `.card { flex-shrink: 0 }` at `width: var(--card-hand-width)` = **52px** on mobile. A 5-card play = `5*52 + 4*4 = 276px` of unshrinkable content.
- `.play-area` adds `16px` padding each side; `.play-area__trick-pile` is absolutely positioned at `left: -64px` relative to the centered `.play-area__center`. Combined, the play's right edge exceeds a ~360px (and worse, 320px) viewport.
- `.game-board--mobile` sets `overflow: clip`, so the excess is truncated instead of scrolled → "goes off screen."

### Decision 1 — Fixed-corner pile on mobile (decouple)

The pile currently lives inside `.play-area__center` and is positioned relative to the centered play. On mobile only, re-anchor it to `.play-area` (which is `position: relative`-eligible — it is the flex column that fills the table grid cell) at a fixed bottom-left corner:

```
@media (max-width: 767px) {
  .play-area { position: relative; }        /* establish containing block */
  .play-area__trick-pile {
    position: absolute;
    left: 8px;
    bottom: 8px;
    top: auto;
    transform: none;                          /* cancel desktop translateY(-50%) */
  }
}
```

Because the pile is now absolutely positioned against `.play-area` (not against the centered play), the width of the played row no longer moves the pile, and the pile can never push the play off-screen. The centered `.play-area__center` keeps its existing centering.

**Rationale for bottom-left corner (vs. desktop's mid-left):** bottom-left keeps the pile clear of the vertically-centered play and the hand-type label above it, and reserves a predictable non-overlap zone (see Decision 4). It preserves "pile on the left" from the approved mockups.

### Decision 2 — Width-cap + flex-shrink the played row (Option C)

Give the played row a max width bounded by the viewport and let cards shrink to fit, capping at their natural size and preserving aspect ratio:

```
@media (max-width: 767px) {
  .play-area__card-row {
    max-width: var(--play-row-max-width);     /* new token, see below */
    width: 100%;
    justify-content: center;
  }
  .play-area__card-row .card--medium {
    flex: 0 1 var(--card-hand-width);          /* may shrink below 52px, never grow past it */
    min-width: 0;                              /* allow shrink below content size */
    height: auto;                              /* preserve aspect via ratio */
    aspect-ratio: var(--card-hand-width) / var(--card-hand-height);
  }
}
```

Key mechanics:
- `.card` today is `flex-shrink: 0`. The override sets `flex: 0 1 <basis>` (shrink allowed, grow disallowed) **scoped to the played row only** so hand cards and Tonk cards are untouched.
- `aspect-ratio` + `height: auto` keeps cards proportional as width shrinks (no squish). This requires the card's internal glyphs to use relative units; `.card--medium` `font-size: 1rem` stays fixed, which is acceptable because at the shrink floor cards are still ~44px wide (rank/suit remain legible). If glyph overflow is observed at 320px, the implementer may add a scoped `font-size` reduction — flagged as a tuning knob, not a required change.

`--play-row-max-width` new token, mobile block only:
- Available table width at 320px ≈ `320 - 2*mobile-rim-width(4) - 2*play-area-padding(16) = 280px`. Reserve the fixed pile's footprint on the left so the centered row and the pile do not collide (Decision 4). Set the token so 5 shrunk cards + gaps fit within the non-reserved width. Recommend `--play-row-max-width: 260px` (mobile), which at 5 cards + 4×4px gaps yields ≈ 48.8px per card — below the 52px cap (shrink engages) and above the ~44px legibility floor. The implementer tunes the exact value against 320px/360px screenshots; the constraint is "5 cards fully visible, centered, not overlapping the pile."

No `transform: scale()`, no `ResizeObserver`, no JS. The row remains a single centered flex row for all play sizes.

### Decision 3 — Static-icon collapsed pile (constant size)

Replace the collapsed layered card stack with a single static representation whose size is independent of trick depth. In `TrickPile.vue`, the collapsed button renders **one** element:
- A single face-down / generic "pile" icon (reuse a `GameCard size="small" face-down` OR a dedicated CSS pile glyph — implementer's choice; a face-down `GameCard` reuses existing styling and is preferred for visual consistency).
- The existing `.trick-pile__badge` (play count) stays, unchanged, as the affordance that communicates depth.

This removes the `v-for="stackLayers"` rendering and the per-layer `left/top` offset from the *collapsed* view. `stackLayers`, `layerStyle`, and `MAX_LAYERS` become unused for the collapsed pile and should be deleted (they exist only to render the layered stack). `topCardOf` is likewise only used by the removed loop — remove if it has no other reference.

The pile's collapsed box becomes a fixed `width/height` (a single small card + badge), so its footprint is constant and known — which is exactly what makes the fixed-corner placement (Decision 1) and the reserved non-overlap zone (Decision 4) deterministic.

The **expanded overlay is unchanged** — it still lists every play in the trick with full medium cards via `currentTrick`/`playEntries`. Tapping the pile still opens it.

### Decision 4 — Pile must not overlap the played cards (rider requirement)

The fixed bottom-left pile and the centered played row share the `.play-area` box. At 320px the played row is width-capped and centered; the pile occupies a fixed bottom-left rectangle. Guarantee non-overlap by:
- Constraining `--play-row-max-width` so the centered row's left edge stays right of the pile's right edge **at the pile's vertical band**, OR
- Placing the pile in the bottom-left corner (below the vertical center where the play sits) so their vertical bands don't intersect even if horizontal extents would.

Recommended: bottom-left corner placement (vertical separation) as the primary guarantee, with the width cap as the secondary guarantee. QA verifies no overlap at 320px and 360px across all play sizes.

### Alternatives considered (and rejected)

- **`transform: scale()` on the row** — explicitly rejected by the approval note; scaling shrinks the hit/visual target unpredictably and interacts badly with `overflow: clip`.
- **`flex-wrap` to a second row** — changes the single-row visual the mockups approved and can collide with the fixed vertical grid-cell height.
- **Horizontal scroll inside the row** — rejected: `.game-board--mobile` sets `overflow: clip`, which suppresses scroll containers; a nested scroll region is fragile here.

## Interfaces / Types

No TypeScript interface, prop, event, shared-type, or engine-signature changes. `PlayArea.vue` props and `TrickPile.vue` props (`playHistory`, `trickStartIndex`) are unchanged.

Internal `TrickPile.vue` script deletions (no external contract impact):
- Remove `MAX_LAYERS`, `stackLayers`, `layerStyle`, and `topCardOf` (all only feed the collapsed layered stack).
- Keep `currentTrick`, `playEntries`, `badgeCount` (badge + overlay), and expand/collapse logic.

New CSS custom property (mobile block of `game-variables.css`):
- `--play-row-max-width: 260px;` (value tunable per Decision 2).

## Frontend Design

Approved direction: **Option C** from the iteration-2 mockups (issue comment 2026-06-30 "Frontend decision: Option C with a small note"). The frontend-decision gate is cleared — **no new mockup is required**. The decision note carries three load-bearing points, all reflected above:

1. **Option C for the played row** — width-cap the row and let cards flex-shrink to share the available width, capping at natural size and preserving aspect ratio. Pure CSS, single centered row, no `transform`/`scale`, no JS/ResizeObserver (Decision 2).
2. **The fixed pile must not overlap the played cards** ("The fixed location of cards should not overlap the played cards") — the pile is pinned to a fixed bottom-left corner of the felt and given a reserved non-overlap zone so it never collides with the centered play at 320px (Decisions 1 and 4).
3. **Static discard-pile icon after the first card** ("consider a static icon for discard pile after the first card ... so the discard pile can retain static size and is easier to handle") — the collapsed pile becomes a single constant-size icon + count badge instead of the current live card stack capped at `MAX_LAYERS=4` (Decision 3). Constant size is what makes the fixed-corner placement deterministic.

Structural intent: **decouple the pile from the played-cards composition.** Today the pile is positioned relative to the centered play (`left: -64px`), which is why a wide 5-card play drags the pile+play past the clipped edge. Pinning the pile to a fixed felt corner breaks that coupling so the play's width can never move the pile and the pile can never push the play off-screen.

Visual acceptance (mobile, 320px and 360px): single centered played row for every play size; all 5 cards of a full house / straight / flush / four-of-a-kind / straight-flush fully visible and proportional; pile fixed in the bottom-left, constant size, never overlapping the play; single and pair unchanged and centered. Desktop (`>=768px`) visually unchanged.

## State Model

Purely presentational. No persisted state, no in-memory game state, no reactive data model changes. All rendering derives from the already-received `PlayerView` (`lastPlay`, `playHistory`, `trickStartIndex`) exactly as today. The removed `stackLayers` was a pure `computed` over existing props; removing it changes only what is drawn, not what is known.

## Edge Cases

1. **Single-card play (mobile):** width cap not reached; card renders at natural 52px, centered. Must look identical to today. `flex: 0 1 52px` with a single item and `justify-content: center` = unchanged.
2. **Pair (2 cards, mobile):** `2*52+4 = 108px` < cap; no shrink, centered. Unchanged.
3. **5-card play at 360px:** shrink engages, all 5 cards fully visible and centered, none clipped at viewport edge.
4. **5-card play at 320px (narrowest supported):** shrink engages harder; cards at/above ~44px floor, all 5 visible, not overlapping the fixed pile.
5. **Pile overlap at 320px:** pile fixed bottom-left, played row centered/width-capped — verify no visual overlap (Decision 4).
6. **New trick / no last play (`lastPlay == null`):** `.play-area__free` message shows; pile hidden (`currentTrick.length === 0`). Fixed-corner rule has no visible element to place — no regression.
7. **First play of a trick (1 play):** pile shows a single static icon + badge "1". No layered stack (there never was more than one to stack anyway).
8. **Deep trick (>4 plays):** previously the stack capped at 4 layered cards; now a single static icon + badge showing the true count (e.g. "6"). Badge already counts all plays — behavior improves (accurate count, constant size).
9. **Expanded overlay after change:** tapping the static pile still opens the full-list overlay unchanged; Escape/backdrop still collapse.
10. **Desktop (`>=768px`):** all new rules are inside `@media (max-width: 767px)`; the collapsed-pile markup change (static icon) applies to both breakpoints, so verify the desktop pile still reads sensibly. The desktop pile was a small layered stack at `left: -88px`; a single static icon + badge is an acceptable, simpler equivalent. If desktop must remain a layered stack, gate the static-icon rendering behind a mobile flag — **implementer decision, but default to shared static icon** since the approval note asks for a static icon generally ("this way the discard pile can retain static size and is easier to handle").
11. **Reduced motion / spectator / reconnection views:** these render the same `PlayArea`/`TrickPile`; no motion added, so no new reduced-motion handling. Spectator sees the same public `lastPlay`/`playHistory` — verify the fixed-corner pile renders in the spectator view too.
12. **Tall mobile viewport with short hand:** fixed bottom-left pile stays inside `.play-area` bounds because it is anchored to that box, not the viewport.

## Dependencies

- **Existing code only.** Builds directly on `PlayArea.vue`, `TrickPile.vue`, `GameCard.vue`, `game-variables.css`, and the `.game-board--mobile` grid in `GameBoard.vue` (LLD 6 Frontend Game UI, LLD 11 mobile layout, and the LLD-that-introduced-TrickPile).
- No upstream LLD must be implemented first. No new packages.
- The frontend-decision gate is **cleared**: Option C approved 2026-06-30; **no new mockup required**.
- `--card-play-width`/`--card-play-height` tokens exist but are currently unused/dead; this LLD does **not** adopt or remove them (out of surgical scope) — noted for the implementer's awareness only.

## Test Requirements

Per testing-principles §10 and the "bias against manual tests" heuristic (§Decision Heuristics 6): automate DOM/layout assertions where feasible; reserve a small manual/visual pass for pixel-level "looks centered / not clipped" judgments that DOM assertions cannot fully capture.

### Unit (Vitest, `tests/frontend/trickPile.test.ts` — extend existing)

- **Collapsed pile is a single element regardless of depth:** after the static-icon change, assert the collapsed representation renders exactly one pile element for 1, 4, and 6 plays (replacing the current `stackLayers` cap-at-4 test). If `stackLayers` is removed, remove/replace the `MAX_LAYERS` test accordingly.
- **Badge count still reflects all plays** (1, 2, 6) — this behavior is preserved and must remain green.
- **Expand/collapse and force-collapse-on-reset** tests remain unchanged and must stay green.

### Integration / E2E (Playwright, `e2e/mobile-layout.spec.ts` — extend)

Seed an IN_PROGRESS Big2 game (reuse `seedInProgressGame`) with a `lastPlay` of a 5-card full house in `gameSpecificState`. At viewport widths 320×568 and 360×640:

- **5-card play is not clipped:** assert every card in `.play-area__card-row .card` has `getBoundingClientRect().right <= window.innerWidth` (and `.left >= 0`), so no card crosses the viewport edge.
- **Row is centered:** assert the row's bounding box is horizontally centered within `.play-area__center` (left/right margins within a small tolerance).
- **Pile is fixed and non-overlapping:** assert the trick pile's bounding rect does not intersect any played card's rect (Decision 4), at both widths, for a 5-card play.
- **Pile position is play-invariant:** capture the pile's rect for a single-card play and for a 5-card play in the same game/viewport; assert the pile's `left`/`bottom` are unchanged between the two (the pile does not move when the play widens).
- **Single-card and pair still centered:** assert a 1-card and a 2-card play render centered and un-clipped (regression guard for Edge Cases 1–2).
- **Desktop unchanged:** at 1024×768, assert `.play-area__trick-pile` retains its desktop offset (`left: -88px`-derived position) and the played row is not width-capped — i.e. the mobile rules did not leak. (Reuse the existing desktop-class test pattern.)

### Manual / visual (documented steps, minimal)

- On a real/emulated 320px and 360px device, play each 5-card type (full house, straight, flush, four-of-a-kind, straight flush) plus a single and a pair; visually confirm: all cards visible, proportions not squished, pile in bottom-left, no overlap. This is the QA pass the selection note requires across all play types × {320, 360}, including spectator and reconnection entry into the same board.

### Out of scope for tests

- No engine, server, or information-leakage tests (no state/logic change). Existing engine and integration suites must continue to pass unmodified.
