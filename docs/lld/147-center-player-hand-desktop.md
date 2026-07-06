# LLD 147: Center the player's card hand on desktop instead of left-aligning it

## Scope

**Covers:** Horizontally centering the player's own card hand (and its "Your hand (n)" label) within the desktop hand strip of the Big2 `GameBoard`, viewport `>= 768px` only. Purely a CSS change across two Vue single-file components.

**Does NOT cover:**
- Mobile layout (`< 768px`) — the existing `@media (max-width: 767px)` rules stay byte-for-byte unchanged.
- The opponent row, play area, action panel, or game log — untouched.
- Any JavaScript, template markup, props, events, or component logic. This is style-only.
- Card sizing, overlap, selection, hover-lift, or scroll behavior — all preserved as-is.
- The spectator view (no player hand rendered).

## Approach

The user approved **Option C (Centered tray)** from the mockup (`docs/mockups/center-player-hand-desktop.html`, branch `lld-135-center-player-hand-desktop`). Two edits:

1. **`GameBoard.vue` — `.game-board__hand`** (currently `display: flex; align-items: center`, a horizontal row): switch to a **column** layout on desktop so the label stacks *above* the cards, and center both axes.
   - `flex-direction: column; align-items: stretch; justify-content: center;`
   - The label ("Your hand (n)") moves from beside the cards to centered above them. **This relocation is intentional and approved** — it is the defining trait of Option C.

2. **`PlayerHand.vue` — `.player-hand`** (currently `display: flex; align-items: flex-end; overflow-x: auto`, no `justify-content`): add **`margin-inline: auto`**, keeping `justify-content: flex-start` (the default). This centers the strip inside its column cell *when the cards fit*, and lets it hug the left edge and remain fully scrollable *when it overflows*.

**Why `margin-inline: auto` and NOT `justify-content: center`:** With a flex container that has `overflow-x: auto`, `justify-content: center` clips the leftmost overflowing children past the left edge and they become unreachable by scrolling (a well-known flexbox + overflow bug). That was mockup **Option B, explicitly rejected**. `margin-inline: auto` centers a *fits* strip but collapses to zero margin when the content is wider than the cell, so the overflow-scroll fallback for a full 13-card hand is preserved and no card clips off the left.

**Desktop-only scoping:** Both new rules live in the default (non-media-query) blocks. The existing `@media (max-width: 767px)` blocks override the mobile-relevant properties — but *only the ones they explicitly declare*, so every new desktop property that would otherwise leak into mobile must be explicitly reset in the mobile block:
- `GameBoard.vue` mobile block currently sets `.game-board--mobile .game-board__hand { flex-direction: column; align-items: flex-start; overflow: hidden; }`. It overrides the new desktop `align-items: stretch` (mobile keeps `flex-start`), and the new desktop `flex-direction: column` merely *matches* mobile's. **But the mobile block does NOT declare `justify-content`, so the new desktop `justify-content: center` would cascade into mobile** and vertically-center the label+hand stack in the fixed 160px hand cell (a mobile regression). The mobile block **must therefore add `justify-content: flex-start`** to pin the current top-aligned behavior (see the required delta below).
- `PlayerHand.vue` mobile block sets `.player-hand { width: 100% }`. A full-width strip with `margin-inline: auto` yields zero side margin (nothing to center), so mobile is visually unaffected. To eliminate any ambiguity, the mobile block will also explicitly reset `margin-inline: 0` (matching the mockup) so the intent is self-documenting and future-proof against padding/width changes.

## Interfaces / Types

None. No TypeScript, props, emits, or shared types change. Template markup is unchanged in both files.

## State Model

No state involved. No persisted or in-memory state. This is a static CSS layout adjustment; reactive data flow (`gameState.you.hand`, `selectedIndices`, `interactive`) is untouched.

## Frontend Design

**Approved direction: Option C — Centered tray.** Source of truth: `docs/mockups/center-player-hand-desktop.html` (branch `lld-135-center-player-hand-desktop`), `body[data-opt="C"]` rules.

Desktop hand strip (`>= 768px`) after the change:

```
┌───────────────────────────────────────────────┐  ← .game-board__hand (grid area "hand")
│                                                 │     flex column, centered both axes
│               YOUR HAND (5)                     │  ← .game-board__hand-label, centered above
│                                                 │
│            [🂡][🂢][🂣][🂤][🂥]                    │  ← .player-hand, margin-inline:auto (centered)
│                                                 │
└───────────────────────────────────────────────┘
```

Full-hand / narrow-window overflow case (leftmost cards remain reachable, no clip):

```
┌───────────────────────────────────────────────┐
│               YOUR HAND (13)                    │
│ [🂡][🂢][🂣][🂤][🂥][🂦][🂧][🂨][🂩][🂪][🂫]→ scroll │  ← margin collapses to 0, hugs left, scrolls
└───────────────────────────────────────────────┘
```

**Exact CSS deltas (implementer reference — final wording is the implementer's, these are the required properties):**

`GameBoard.vue`, `.game-board__hand` (~line 281) — add to the existing rule (keep `background`, `border-top`, `grid-area`):
```css
.game-board__hand {
  grid-area: hand;
  display: flex;
  flex-direction: column;      /* CHANGED: was implicit row */
  align-items: stretch;        /* CHANGED: was center */
  justify-content: center;     /* ADDED: vertical centering of the label+tray stack */
  background: var(--felt-light);
  border-top: 2px solid var(--table-rim-light);
}
```

`GameBoard.vue`, `.game-board__hand-label` (~line 305) — center the label and drop the left indent:
```css
.game-board__hand-label {
  /* ...existing font/size/color/transform... */
  text-align: center;          /* CHANGED from left-aligned */
  padding-left: 0;             /* CHANGED: was 12px */
  padding-top: 10px;           /* ADDED: breathing room above the tray */
  margin-bottom: 2px;
}
```

`PlayerHand.vue`, `.player-hand` (~line 55) — center the tray when it fits, keep overflow safety:
```css
.player-hand {
  display: flex;
  align-items: flex-end;
  justify-content: flex-start; /* explicit (unchanged default) — do NOT use center */
  margin-inline: auto;         /* ADDED: centers when it fits, collapses when it overflows */
  padding: 24px 16px 8px;
  overflow-x: auto;
}
```

`PlayerHand.vue`, mobile block `@media (max-width: 767px) .player-hand` — add an explicit reset so full-width mobile is provably unaffected:
```css
@media (max-width: 767px) {
  .player-hand {
    width: 100%;
    margin-inline: 0;          /* ADDED: full-width → no centering on mobile */
    /* ...existing padding / touch / scrollbar rules unchanged... */
  }
}
```

`GameBoard.vue`, mobile block `@media (max-width: 767px) .game-board--mobile .game-board__hand` — **REQUIRED** reset. The new desktop `justify-content: center` (on the base `.game-board__hand` rule) would otherwise cascade into mobile, because the existing mobile override declares only `flex-direction`, `align-items`, and `overflow` — it does **not** declare `justify-content`. Left unreset, the label+hand stack inside the fixed `--mobile-hand-height` (160px) cell would shift from top-aligned to vertically centered, silently changing mobile. Add an explicit `flex-start` to pin the current top-aligned behavior:
```css
@media (max-width: 767px) {
  .game-board--mobile .game-board__hand {
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start; /* ADDED: reset the new desktop justify-content:center — keep label+hand top-aligned in the 160px mobile cell */
    overflow: hidden; /* contain within grid cell */
  }
}
```

**Constraints (must hold):**
- Card selection, hover-lift (`@media (hover: hover)`), and click/tap (`@click` / `@touchstart`) behavior is unchanged — none of those selectors or handlers are touched.
- The `--card-overlap` negative-margin fan and `player-hand__card--first` reset are unchanged.
- Existing `overflow-x: auto` horizontal scroll is the fallback for a hand wider than the cell; it must remain functional.

## Edge Cases

1. **Full 13-card hand in a narrow desktop window (cards wider than the cell).** `margin-inline: auto` collapses to `0` (flex content wider than container → no free space to distribute), strip hugs the left edge, `overflow-x: auto` scroll reaches every card. No left clipping. This is the scenario Option B fails and Option C must pass — primary manual check.
2. **Few cards (e.g. 5) on a wide desktop.** Strip is narrower than the cell → `margin-inline: auto` centers it; label centered above. Matches the approved mockup.
3. **Boundary width exactly 768px.** `>= 768px` uses desktop rules (centered); `<= 767px` uses mobile rules. The `matchMedia("(max-width: 767px)")` driver for `isMobile` and the CSS `@media (max-width: 767px)` breakpoints agree, so no gap or overlap at the boundary.
4. **`isFinished` state ("Finished — waiting for others.").** The label still renders above; `.game-board__finished` replaces `PlayerHand`. It has its own `padding: 0 24px`; under the new column/stretch parent it renders below the centered label. Acceptable — it is a transient end-of-round message, and the change does not regress it (verify it is not clipped).
5. **Zero cards in hand (momentary, between deal and render / after emptying).** `PlayerHand` renders an empty flex container; `margin-inline: auto` on an empty strip is a no-op. No layout break.
6. **Mobile column layout collision / `justify-content` leak.** The mobile block sets `flex-direction: column; align-items: flex-start; overflow: hidden`. The new desktop `flex-direction: column` is identical in axis, and mobile's `align-items: flex-start` overrides the desktop `align-items: stretch` by source order / specificity. **However, the mobile block declares no `justify-content`**, so the new desktop `justify-content: center` would otherwise cascade in and vertically-center the label+hand stack in the 160px hand cell. The required mobile-block delta (see "Frontend Design") adds `justify-content: flex-start` to reset this. Confirm mobile label stays top- and left-aligned and cards left-aligned, unchanged from current.

## Dependencies

- **Existing code only.** Builds directly on `src/frontend/component/game/GameBoard.vue` and `src/frontend/component/game-ui/PlayerHand.vue` as they stand on `main`.
- No upstream LLD is a prerequisite; this is a standalone polish item on the Frontend Game UI (LLD 6) surface.
- Design assets: `docs/mockups/center-player-hand-desktop.html` (branch `lld-135-center-player-hand-desktop`) — the approved Option C reference. No blocking dependency; it is a read-only reference.

## Test Requirements

Per `docs/testing-principles.md` §"Decision Heuristics" #6, layout/responsiveness is the sanctioned exception where a manual visual check is appropriate over an automated test. There is no game-engine logic here.

**Automated (optional, low value): none required.** No engine, view-filtering, or validation logic changes, so none of the engine/invariant/leakage test categories apply. If the project has DOM-level component tests, an optional assertion that `.game-board__hand-label` and `.player-hand` carry the centering styles adds little over the manual checks below and is not required.

**Manual (required — visual, desktop viewport `>= 768px`):**

| # | Scenario | Expected |
|---|----------|----------|
| M1 | Desktop, small hand (~5 cards) | Label "Your hand (n)" centered above; card tray horizontally centered in the strip; no large right-side gap. |
| M2 | Desktop wide, full 13-card hand | Cards lay out without clipping; if they fit, tray is centered; if not, tray hugs left and scrolls. |
| M3 | Desktop **narrow** window, full 13-card hand | Leftmost cards NOT clipped off the left edge; every card reachable via horizontal scroll (the Option B failure must not occur). |
| M4 | Mobile viewport (`< 768px`) | Layout visually **unchanged** from current: label top- and left-aligned in the 160px hand cell (NOT vertically centered), cards left-aligned and horizontally scrollable. |
| M5 | Card interactions (desktop) | Click/tap toggles selection; selected cards lift; hover lift works on hover-capable devices — all unchanged. |
| M6 | `isFinished` state (desktop) | "Finished — waiting for others." renders below the centered label without clipping. |

**Regression guard:** Diff must contain only CSS inside the two named files; zero changes to `<template>` or `<script>` blocks. Confirm the `@media (max-width: 767px)` blocks in both files are unchanged except for the two explicit resets required to prevent desktop properties leaking into mobile: `margin-inline: 0` on `.player-hand` in `PlayerHand.vue`, and `justify-content: flex-start` on `.game-board--mobile .game-board__hand` in `GameBoard.vue`. No other mobile-block lines may change.
