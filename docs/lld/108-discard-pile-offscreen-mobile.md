# LLD 108: Discard pile goes off-screen on mobile when playing a full house

## Scope

**Covers:** The mobile rendering of the Big2 current play (`PlayArea.vue`) and its adjacent trick pile (`TrickPile.vue`) so that a 5-card combination (full house, straight, flush, four-of-a-kind, straight flush) is fully visible inside the clipped mobile table area at viewport widths down to 320px.

Two coupled structural changes:

1. **Decouple the trick pile from the played-cards composition on mobile.** Today the pile is `position: absolute; left: -64px` relative to the centered play, so a wide play drags pile + play past the right edge and `overflow: clip` on `.game-board--mobile` truncates it. Pin the pile to a fixed corner of the felt (bottom-left of `.play-area`) on mobile so it no longer participates in the horizontal extent of the play.
2. **Width-cap the played row and let cards flex-shrink to share the available width** (Option C, approved 2026-06-30 "Frontend decision: Option C"). Pure CSS, single centered row, preserve aspect ratio, no transform/scale, no JS.

Plus one supporting change carried by the frontend decision note:

3. **Render the collapsed trick pile as a single static icon on mobile** instead of a live card stack, so the pile is a constant size regardless of trick depth. This simplifies fixed-corner placement. **Scoped to mobile only** — desktop keeps its existing `MAX_LAYERS=4` layered stack byte-for-byte (see Decision 3 and Edge Case 10 for why the static icon is mobile-only rather than shared).

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

The pile currently lives inside `.play-area__center` and is positioned relative to the centered play. On mobile only, re-anchor it so it resolves against the full-height `.play-area` box (the flex column that fills the table grid cell) at a fixed bottom-left corner.

**Containing-block correction (critical).** An absolutely-positioned element resolves against its *nearest positioned ancestor*. Today `.play-area__trick-pile` is rendered as a child of `.play-area__center` (PlayArea.vue lines 11–16), and `.play-area__center` is `position: relative` (PlayArea.vue line 103) **solely** so it can be that ancestor for the pile. Therefore simply adding `position: relative` to `.play-area` does **not** re-anchor the pile — `.play-area__center` is closer and still wins. To make the pile resolve against `.play-area` (the full-height felt column), the mobile block must (a) establish `.play-area` as a positioned containing block **and** (b) demote `.play-area__center` to `position: static` so it stops being the nearest positioned ancestor.

**Side-effect check for `.play-area__center { position: static }` on mobile:** `.play-area__center`'s `position: relative` today has exactly one purpose — parenting the absolutely-positioned `.play-area__trick-pile`. It has no `top/left/right/bottom`, no `z-index`, no `overflow`/clip, and its only absolutely-positioned descendant is the pile (which this LLD is re-anchoring away from it). Demoting it to `static` on mobile therefore has no other layout effect: the centered flex-column content (`.play-area__cards` / `.play-area__free`) is unaffected. This is a required override, not an implementer choice.

In `PlayArea.vue`, mobile block:

```
@media (max-width: 767px) {
  /* (a) Make .play-area the containing block for the pile. */
  .play-area { position: relative; }
  /* (b) Demote the centered box so it is no longer the nearest positioned
         ancestor — otherwise the pile still anchors to the shrink-wrapped
         centered play, not the felt corner. */
  .play-area__center { position: static; }
  .play-area__trick-pile {
    position: absolute;
    left: 8px;
    bottom: 8px;
    top: auto;
    transform: none;                          /* cancel desktop translateY(-50%) */
  }
}
```

With both (a) and (b) in place, the pile is absolutely positioned against `.play-area` (the full-height felt column), not against the centered, shrink-wrapped `.play-area__center` that sits right at the play. So the width and vertical center of the played row no longer move the pile: it is pinned to the felt's true bottom-left corner, vertically separated from the vertically-centered play (which is the separation Decision 4's primary non-overlap guarantee depends on). The centered `.play-area__center` keeps its existing centering. The pile markup stays a child of `.play-area__center` (no template relocation needed) — the `static`/`relative` override is what re-parents its positioning.

> Alternative (rejected): relocating `.play-area__trick-pile` to be a direct child of `.play-area` in the template would also work, but it changes markup structure for both breakpoints (or forces two branches) and is more invasive than the two-line CSS override above. The CSS override is preferred as the surgical change.

**The mobile inner scale is removed, not merely wrapped.** `TrickPile.vue` today applies `transform: scale(0.85); transform-origin: top left;` to `.trick-pile__stack` inside its own `@media (max-width: 767px)` block (TrickPile.vue lines 316–320). The `transform: none` above is on the *outer* `.play-area__trick-pile` wrapper and does **not** cancel that inner scale — so the pile's real footprint today is the scaled box, not the nominal `28px+18px` / `40px+18px`. This LLD removes the `transform: scale(0.85)` rule on `.trick-pile__stack` in the mobile block of `TrickPile.vue` so the collapsed pile has a single, unscaled, deterministic footprint. The mobile static-icon layer (Decision 3) is instead given explicit `width`/`height` sized for mobile, so the collapsed box is exactly the icon + badge with no residual scale transform. This is the "constant, known footprint" that Decisions 3 and 4 depend on; the footprint math in Decision 2 and the non-overlap zone in Decision 4 reference this unscaled box.

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

### Decision 3 — Static-icon collapsed pile on mobile only (constant size); desktop unchanged

On **mobile only**, replace the collapsed layered card stack with a single static representation whose size is independent of trick depth. On **desktop (`>=768px`) the existing layered stack is preserved byte-for-byte** (see below and Edge Case 10). This is the resolution to the desktop byte-for-byte constraint (Scope line): the static-icon change is not applied to desktop, so the desktop `v-for="stackLayers"` layered markup, `layerStyle`, `topCardOf`, and `MAX_LAYERS` all remain in place and render identically to today.

**Mechanism — JS breakpoint, not CSS.** Because the two breakpoints render *different markup* (one static layer vs. up to four offset layers), a CSS media query alone cannot switch template structure. `TrickPile.vue` gains an `isMobile` reactive flag using the same `window.matchMedia("(max-width: 767px)")` pattern already proven in `GameBoard.vue` (its `isMobile` ref + `mql.addEventListener("change", …)` + `onUnmounted` cleanup). The collapsed button then branches:

```
<!-- Mobile: one static layer, constant footprint -->
<span v-if="isMobile" class="trick-pile__layer trick-pile__layer--static">
  <GameCard :card="topCardOf(latestPlay)" size="small" />
</span>
<!-- Desktop: existing layered stack, unchanged -->
<template v-else>
  <span
    v-for="(entry, i) in stackLayers"
    :key="`layer-${i}`"
    class="trick-pile__layer"
    :style="layerStyle(i)"
  >
    <GameCard :card="topCardOf(entry)" size="small" />
  </span>
</template>
```

- **Invariant — the mobile static layer must retain the `.trick-pile__layer` class** (the second class `trick-pile__layer--static` is additive, for mobile-only styling). Both the desktop layered spans and the mobile static span carry the shared `.trick-pile__layer` class, so the E2E count selector `.play-area__trick-pile .trick-pile__layer` matches exactly one element on mobile and up to `MAX_LAYERS` on desktop. An implementer must **not** rename the static layer's shared class to something that drops `trick-pile__layer` (e.g. only `trick-pile__static`) — doing so silently breaks the mobile count assertion (Test Requirements → E2E) with no compile error.
- The single mobile layer shows the top (most recent) play's representative card — reuse a `GameCard size="small"` for visual consistency with the overlay and desktop stack (a dedicated CSS glyph is an acceptable alternative but not preferred).
- The existing `.trick-pile__badge` (play count) stays unchanged on both breakpoints as the affordance that communicates depth.
- `latestPlay` is the last entry of `playEntries` (the most-recent play); it feeds only the mobile static layer. `stackLayers`, `layerStyle`, `topCardOf`, and `MAX_LAYERS` are **retained** because desktop still uses them. Nothing in the collapsed logic is deleted — this keeps desktop byte-for-byte and avoids the "no logic left to assert" problem (see Test Requirements).

The pile's collapsed box on **mobile** becomes a fixed, unscaled `width/height` (one small card + badge, with the `transform: scale(0.85)` removed per Decision 1), so its footprint is constant and known — which is exactly what makes the fixed-corner placement (Decision 1) and the reserved non-overlap zone (Decision 4) deterministic. On desktop the footprint is the existing layered stack, unchanged.

The **expanded overlay is unchanged** on both breakpoints — it still lists every play in the trick with full medium cards via `currentTrick`/`playEntries`. Tapping the pile still opens it.

### Decision 4 — Pile must not overlap the played cards (rider requirement)

The fixed bottom-left pile and the centered played row share the `.play-area` box. This vertical separation only holds because Decision 1's containing-block correction makes the pile resolve against the full-height `.play-area` (so `bottom: 8px` reaches the felt's true bottom edge, well below the vertically-centered play) rather than against the shrink-wrapped `.play-area__center` (where `bottom: 8px` would sit right at the play and defeat this guarantee). At 320px the played row is width-capped and centered; the pile occupies a fixed bottom-left rectangle. Guarantee non-overlap by:
- Constraining `--play-row-max-width` so the centered row's left edge stays right of the pile's right edge **at the pile's vertical band**, OR
- Placing the pile in the bottom-left corner (below the vertical center where the play sits) so their vertical bands don't intersect even if horizontal extents would.

Recommended: bottom-left corner placement (vertical separation) as the primary guarantee, with the width cap as the secondary guarantee. QA verifies no overlap at 320px and 360px across all play sizes.

### Alternatives considered (and rejected)

- **`transform: scale()` on the row** — explicitly rejected by the approval note; scaling shrinks the hit/visual target unpredictably and interacts badly with `overflow: clip`.
- **`flex-wrap` to a second row** — changes the single-row visual the mockups approved and can collide with the fixed vertical grid-cell height.
- **Horizontal scroll inside the row** — rejected: `.game-board--mobile` sets `overflow: clip`, which suppresses scroll containers; a nested scroll region is fragile here.

## Interfaces / Types

No TypeScript interface, prop, event, shared-type, or engine-signature changes. `PlayArea.vue` props and `TrickPile.vue` props (`playHistory`, `trickStartIndex`) are unchanged.

Internal `TrickPile.vue` script changes (no external contract impact):
- **Add** an `isMobile` reactive flag via `window.matchMedia("(max-width: 767px)")` (mirroring `GameBoard.vue`), with a `change` listener registered on mount and removed in `onUnmounted` alongside the existing `keydown` cleanup.
- **Add** a `latestPlay` computed = last entry of `playEntries` (drives the mobile static layer only). Handles the empty case (component only renders when `currentTrick.length > 0`, but `playEntries` can be empty if the current trick is all passes — see Edge Case 13).
- **Retain** `MAX_LAYERS`, `stackLayers`, `layerStyle`, and `topCardOf` — desktop still renders the layered stack from them. Nothing is deleted.
- **Retain** `currentTrick`, `playEntries`, `badgeCount`, and expand/collapse logic unchanged.

New CSS custom property (mobile block of `game-variables.css`):
- `--play-row-max-width: 260px;` (value tunable per Decision 2).

## Frontend Design

Approved direction: **Option C** from the iteration-2 mockups (issue comment 2026-06-30 "Frontend decision: Option C with a small note"). The frontend-decision gate is cleared — **no new mockup is required**. The decision note carries three load-bearing points, all reflected above:

1. **Option C for the played row** — width-cap the row and let cards flex-shrink to share the available width, capping at natural size and preserving aspect ratio. Pure CSS, single centered row, no `transform`/`scale`, no JS/ResizeObserver (Decision 2).
2. **The fixed pile must not overlap the played cards** ("The fixed location of cards should not overlap the played cards") — the pile is pinned to a fixed bottom-left corner of the felt and given a reserved non-overlap zone so it never collides with the centered play at 320px (Decisions 1 and 4).
3. **Static discard-pile icon** ("consider a static icon for discard pile after the first card ... so the discard pile can retain static size and is easier to handle") — the collapsed pile becomes a single constant-size icon + count badge **on mobile**, where the fixed-corner placement needs a deterministic footprint (Decision 3). Desktop keeps its layered stack (`MAX_LAYERS=4`) unchanged, because the desktop byte-for-byte constraint takes precedence there and desktop has no off-screen problem to solve. Constant mobile size is what makes the fixed-corner placement deterministic.

Structural intent: **decouple the pile from the played-cards composition.** Today the pile is positioned relative to the centered play (`left: -64px`), which is why a wide 5-card play drags the pile+play past the clipped edge. Pinning the pile to a fixed felt corner breaks that coupling so the play's width can never move the pile and the pile can never push the play off-screen.

Visual acceptance (mobile, 320px and 360px): single centered played row for every play size; all 5 cards of a full house / straight / flush / four-of-a-kind / straight-flush fully visible and proportional; pile fixed in the bottom-left, constant size, never overlapping the play; single and pair unchanged and centered. Desktop (`>=768px`) visually unchanged.

## State Model

Purely presentational. No persisted state, no in-memory game state, no reactive data model changes. All rendering derives from the already-received `PlayerView` (`lastPlay`, `playHistory`, `trickStartIndex`) exactly as today. The one new reactive input is client-only viewport state: `isMobile` (from `matchMedia`) plus a `latestPlay` computed over existing props — both affect only what is drawn, not what is known. No existing derivation (`stackLayers` etc.) is removed.

## Edge Cases

1. **Single-card play (mobile):** width cap not reached; card renders at natural 52px, centered. Must look identical to today. `flex: 0 1 52px` with a single item and `justify-content: center` = unchanged.
2. **Pair (2 cards, mobile):** `2*52+4 = 108px` < cap; no shrink, centered. Unchanged.
3. **5-card play at 360px:** shrink engages, all 5 cards fully visible and centered, none clipped at viewport edge.
4. **5-card play at 320px (narrowest supported):** shrink engages harder; cards at/above ~44px floor, all 5 visible, not overlapping the fixed pile.
5. **Pile overlap at 320px:** pile fixed bottom-left, played row centered/width-capped — verify no visual overlap (Decision 4).
6. **New trick / empty current trick (`currentTrick.length === 0`):** `.play-area__free` message shows and the whole `TrickPile` is not rendered (its root `v-if="currentTrick.length > 0"` is false — this is derived from `playHistory`/`trickStartIndex`, not from `lastPlay`). Fixed-corner rule has no visible element to place — no regression.
7. **First play of a trick (1 play), mobile:** pile shows a single static small card + badge "1". Desktop shows the existing single-layer stack (`stackLayers` length 1) at `left: -88px`, unchanged.
8. **Deep trick (>4 plays):** mobile shows a single static icon + badge with the true count (e.g. "6"), constant footprint. Desktop still caps the layered stack at `MAX_LAYERS=4` with the badge showing the true count — unchanged from today.
9. **Expanded overlay after change:** tapping the collapsed pile (static on mobile, stack on desktop) still opens the full-list overlay unchanged; Escape/backdrop still collapse.
10. **Desktop (`>=768px`) — must be byte-for-byte identical:** the static-icon change (Decision 3) is **not** applied to desktop. The `isMobile` branch renders the existing `v-for="stackLayers"` layered stack via the unchanged `layerStyle`/`topCardOf`/`MAX_LAYERS`, at `left: -88px`, with no new CSS reaching the desktop breakpoint (all layout rules are inside `@media (max-width: 767px)`). This is not an implementer decision — desktop is exempted from the static-icon change to honor the Scope byte-for-byte constraint.
11. **Reduced motion / spectator / reconnection views:** these render the same `PlayArea`/`TrickPile`; no motion added, so no new reduced-motion handling. Spectator sees the same public `lastPlay`/`playHistory` — verify the fixed-corner pile renders in the spectator view too.
12. **Tall mobile viewport with short hand:** fixed bottom-left pile stays inside `.play-area` bounds because it is anchored to that box, not the viewport.
13. **Current trick with plays present but `latestPlay` guard:** the pile only renders when `currentTrick.length > 0`, and a trick always opens with a lead play, so `playEntries` is normally non-empty. Still, guard `latestPlay` (and thus the mobile static layer) against an empty `playEntries` (`v-if="latestPlay"`) so a defensive/degenerate state renders the badge without crashing on an undefined card.

## Dependencies

- **Existing code only.** Builds directly on `PlayArea.vue`, `TrickPile.vue`, `GameCard.vue`, `game-variables.css`, and the `.game-board--mobile` grid in `GameBoard.vue` (LLD 6 Frontend Game UI, LLD 11 mobile layout, and the LLD-that-introduced-TrickPile).
- No upstream LLD must be implemented first. No new packages.
- The frontend-decision gate is **cleared**: Option C approved 2026-06-30; **no new mockup required**.
- `--card-play-width`/`--card-play-height` tokens exist but are currently unused/dead; this LLD does **not** adopt or remove them (out of surgical scope) — noted for the implementer's awareness only.

## Test Requirements

Per testing-principles §10 and the "bias against manual tests" heuristic (§Decision Heuristics 6): automate DOM/layout assertions where feasible; reserve a small manual/visual pass for pixel-level "looks centered / not clipped" judgments that DOM assertions cannot fully capture.

### Unit (Vitest, `tests/frontend/trickPile.test.ts` — extend existing)

This file is a pure node-environment transcription of the component's `<script setup>` derivation (no DOM mount). It can only assert on the reactive logic (`computed`/`watch`), **not** on rendered element counts. Since Decision 3 **retains** `stackLayers`/`MAX_LAYERS` (desktop still uses them), the existing logic-level tests stay valid; the "exactly one collapsed element" assertion is a DOM concern and is therefore deferred to E2E (see below), not asserted here.

- **`stackLayers` cap-at-4 + most-recent-on-top** (the existing `MAX_LAYERS` test): stays as-is and must remain green — it now documents the *desktop* collapsed representation, which is unchanged.
- **New `latestPlay` derivation:** add a logic test that `latestPlay` equals the last entry of `playEntries` for 1, 3, and 6 plays, and is `undefined`/empty when the current trick has no plays (feeds the mobile static layer + its `v-if` guard, Edge Case 13). Transcribe the new computed into the test harness alongside the existing ones.
- **Badge count still reflects all plays** (1, 2, 6) — preserved; must remain green.
- **Expand/collapse and force-collapse-on-reset** tests remain unchanged and must stay green.

Note: `isMobile` and the mobile-vs-desktop *rendered* branch are not testable in this node harness (no `matchMedia`, no mount). The single-collapsed-element and desktop-layered-stack assertions live in E2E where a real viewport and DOM exist. If the team later wants component-level coverage of the branch, a `@vue/test-utils` + jsdom mounting harness would be required — out of scope for this LLD's node-only file.

### Integration / E2E (Playwright, `e2e/mobile-layout.spec.ts` — extend)

**`seedInProgressGame` must be parameterized, not merely reused.** The current helper (`e2e/mobile-layout.spec.ts` lines 46–87) hardcodes `lastPlay: null`, `lastPlayPlayerIndex: null`, `playHistory: []`, and `isFirstPlayOfGame: true`, so it produces an empty current trick and cannot render any played row or pile. Extend the helper to accept an optional overrides argument (e.g. `lastPlay`, `lastPlayPlayerIndex`, `playHistory`, `isFirstPlayOfGame`, `isFreePlay`) merged into `gameSpecificState`, so a test can seed:
- a 5-card full-house `lastPlay` (with a matching `playHistory` entry so `currentTrick`/the pile render), for the off-screen/centering/overlap assertions;
- a single-card and a two-card `lastPlay` for the regression cases;
- a single-card vs. 5-card pair of states in the same viewport for the pile-position-invariance check.

Keep existing callers working by defaulting the overrides to today's empty-trick values. At viewport widths 320×568 and 360×640:

- **5-card play is not clipped:** assert every card in `.play-area__card-row .card` has `getBoundingClientRect().right <= window.innerWidth` (and `.left >= 0`), so no card crosses the viewport edge.
- **Row is centered:** assert the row's bounding box is horizontally centered within `.play-area__center` (left/right margins within a small tolerance).
- **Pile is fixed and non-overlapping:** assert the trick pile's bounding rect does not intersect any played card's rect (Decision 4), at both widths, for a 5-card play.
- **Pile position is play-invariant:** capture the pile's rect for a single-card play and for a 5-card play in the same game/viewport; assert the pile's `left`/`bottom` are unchanged between the two (the pile does not move when the play widens).
- **Single-card and pair still centered:** assert a 1-card and a 2-card play render centered and un-clipped (regression guard for Edge Cases 1–2).
- **Collapsed pile is a single element on mobile regardless of depth:** at 320/360, seed a deep trick (e.g. 4+ plays) and assert the collapsed pile renders exactly one `.play-area__trick-pile .trick-pile__layer` element (the mobile static branch), while the badge still shows the true count. This assertion depends on the Decision 3 invariant that the mobile static layer retains the shared `.trick-pile__layer` class (plus its additive `--static` modifier); the count selector matches it precisely because of that shared class. This is the DOM assertion the node-only unit test cannot make (finding: unit-test premise).
- **Desktop unchanged:** at 1024×768, seed a deep trick (e.g. 4+ plays) and assert desktop still renders the **layered stack** — i.e. more than one `.play-area__trick-pile .trick-pile__layer` element (the mobile static branch renders exactly one; desktop must render up to `MAX_LAYERS`). Also assert `.play-area__trick-pile` retains its desktop offset (`left: -88px`-derived position) and the played row is not width-capped — i.e. the mobile rules did not leak. (Reuse the existing desktop-class test pattern.)

### Manual / visual (documented steps, minimal)

- On a real/emulated 320px and 360px device, play each 5-card type (full house, straight, flush, four-of-a-kind, straight flush) plus a single and a pair; visually confirm: all cards visible, proportions not squished, pile in bottom-left, no overlap. This is the QA pass the selection note requires across all play types × {320, 360}, including spectator and reconnection entry into the same board.

### Out of scope for tests

- No engine, server, or information-leakage tests (no state/logic change). Existing engine and integration suites must continue to pass unmodified.
