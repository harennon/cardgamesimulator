# LLD Hotfix: Mobile Game Board — Firefox Android

## Scope

**Covers:**
- Fixing the game board layout on Firefox Android (378x707 viewport, rv:151.0) where cards are clipped and play/pass buttons are not visible
- Addressing three root causes: viewport height calculation, `overflow: clip` support, and the interaction between `position: fixed; inset: 0` and Firefox's URL bar

**Does NOT cover:**
- Desktop layout changes (must remain identical)
- Chrome Android or Safari iOS changes (must remain working)
- New features, interactions, or component restructuring
- Game logic or state changes

---

## Approach

### Root Cause Analysis

Three issues compound to break the layout on Firefox Android:

**Issue 1: `position: fixed; inset: 0` and Firefox URL bar**

On Firefox Android, `position: fixed; inset: 0` resolves to the "large viewport" — the viewport size when the URL bar is HIDDEN. When the URL bar is visible (which it is on initial load and during normal browsing), the actual visible area is ~50-70px shorter. The grid allocates fixed rows (52px + 160px + 56px = 268px) and gives the remainder to `1fr`. The `1fr` calculation is based on the large viewport height, but the visible area is smaller, pushing the actions row below the visible fold.

On Chrome Android, `position: fixed` uses the visual viewport (what's currently visible), so it works correctly.

**Issue 2: `overflow: clip` browser support**

The mobile layout uses `overflow: clip` on `.game-board--mobile` (line 289). `overflow: clip` was added to Firefox 81 (Sept 2020), so Firefox Android 151 DOES support it. However, there is a documented Firefox bug where `overflow: clip` on a `position: fixed` element with `inset: 0` does not properly clip in certain grid configurations. The fallback in the desktop styles is `overflow: hidden` (line 201), which creates a scroll container and interferes with the nested `overflow-x: auto` on `.player-hand`.

**Issue 3: No `overflow: clip` fallback path**

If `overflow: clip` malfunctions (or is overridden), the base `.game-board` rule has `overflow: hidden`. This creates a containing block for overflow, which means the `overflow-x: auto` on `.player-hand` fights against the parent's hidden overflow. Cards at the edges of the hand are clipped and cannot be scrolled into view.

### Fix Strategy

A minimal, CSS-focused fix addressing each issue:

1. **Replace `position: fixed; inset: 0` with `dvh`-based sizing on mobile** — Use `height: 100dvh` (dynamic viewport height) which accounts for the URL bar on all browsers. Provide `100vh` as fallback for browsers without `dvh` support (though Firefox 100+ supports `dvh`). Keep `position: fixed` for anchoring but use explicit height instead of `inset: 0` for the block axis.

2. **Add `overflow: clip` fallback** — Before the `overflow: clip` declaration, add `overflow: hidden` as a fallback. Then add a separate `overflow-y: clip` after to ensure newer browsers use `clip`. For the hand's scroll, ensure the hand container uses `overflow-x: auto; overflow-y: visible` explicitly.

3. **Use `min-height: 0` on grid rows** — Firefox's grid implementation sometimes does not properly shrink `1fr` rows when the container is smaller than expected. Adding `min-height: 0` on the table area ensures it can shrink.

**Why not use JavaScript to measure viewport height?** The `dvh` unit is specifically designed for this problem and is supported in Firefox 108+, Chrome 108+, and Safari 15.4+. A JS solution would add complexity and a flash of incorrect layout on load.

---

## Interfaces / Types

No TypeScript changes. This is a CSS-only fix.

---

## State Model

No state changes. The existing `isMobile` ref and matchMedia logic remain unchanged.

---

## Detailed Changes

### File: `src/frontend/styles/game-variables.css`

No changes needed. The CSS custom properties are correct.

### File: `src/frontend/component/game/GameBoard.vue` (scoped styles)

**Change 1: Fix the mobile height calculation**

Current (line 184-202):
```css
.game-board {
  position: fixed;
  inset: 0;
  /* ... */
  overflow: hidden;
}
```

The base `.game-board` stays unchanged (desktop uses `inset: 0` which works correctly on desktop browsers and Chrome Android).

Current mobile override (lines 279-290):
```css
@media (max-width: 767px) {
  .game-board--mobile {
    grid-template-rows:
      var(--mobile-opponent-height) 1fr var(--mobile-hand-height)
      var(--mobile-actions-height);
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "opponents"
      "table"
      "hand"
      "actions";
    overflow: clip;
  }
  /* ... */
}
```

Replace with:
```css
@media (max-width: 767px) {
  .game-board--mobile {
    /* Override inset: 0 block axis — use dvh for Firefox URL bar compat */
    top: 0;
    bottom: auto;
    height: 100vh;   /* fallback for older browsers */
    height: 100dvh;  /* dynamic viewport height — accounts for URL bar */

    grid-template-rows:
      var(--mobile-opponent-height) 1fr var(--mobile-hand-height)
      var(--mobile-actions-height);
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "opponents"
      "table"
      "hand"
      "actions";

    /* clip prevents scroll context creation; hidden is fallback */
    overflow: hidden;
    overflow: clip;
  }

  .game-board--mobile .game-board__table {
    min-height: 0;  /* Allow 1fr row to shrink on Firefox */
  }

  /* ... rest unchanged ... */
}
```

**Key decisions:**
- `top: 0; bottom: auto; height: 100dvh` — Overrides the `inset: 0` from the base rule for the vertical axis only. `inset: 0` sets all four sides; we override `bottom` to `auto` and use explicit `height`. The horizontal `left: 0; right: 0` from `inset` remains active (correct).
- `height: 100vh` then `height: 100dvh` — CSS fallback pattern. Browsers that don't understand `dvh` ignore the second declaration and use `100vh`. All target browsers (Firefox 108+, Chrome 108+, Safari 15.4+) support `dvh`.
- Duplicate `overflow` declarations — Browsers that don't support `clip` use `hidden` (the first one). Browsers that DO support `clip` use the second. This is a standard progressive enhancement pattern.
- `min-height: 0` on the table area — Firefox's grid algorithm can give `1fr` tracks a minimum size based on content. This override ensures the table row shrinks to fit the available space.

**Change 2: Ensure hand scroll works under `overflow: hidden` fallback**

The `.game-board__hand` already has `flex-direction: column` on mobile. The issue is that when the parent has `overflow: hidden`, the nested scroll on `.player-hand` can be inhibited. Add explicit containment:

```css
.game-board--mobile .game-board__hand {
  flex-direction: column;
  align-items: flex-start;
  overflow: hidden;  /* contain within grid cell */
}
```

This creates an explicit overflow context for the hand cell, which allows the inner `.player-hand` (with `overflow-x: auto`) to scroll independently regardless of the grandparent's overflow setting.

### File: `src/frontend/component/game-ui/PlayerHand.vue` (scoped styles)

**Change: Explicit overflow-y on mobile**

Current mobile styles:
```css
@media (max-width: 767px) {
  .player-hand {
    width: 100%;
    padding: 20px 12px 4px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    scrollbar-width: none;
  }
}
```

Add `overflow-y: visible` to prevent Firefox from making BOTH axes scroll when one axis is `auto`:

```css
@media (max-width: 767px) {
  .player-hand {
    width: 100%;
    padding: 20px 12px 4px;
    overflow-x: auto;
    overflow-y: visible;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    scrollbar-width: none;
  }
}
```

**Rationale:** Per CSS Overflow spec, if one axis is set to a scroll value (`auto`/`scroll`/`hidden`) and the other is `visible`, the browser computes `visible` as `auto`. HOWEVER, by explicitly stating both, we signal intent and prevent Firefox from applying its own heuristic. More critically, the `overflow-y: visible` here, combined with `overflow: hidden` on the parent `.game-board__hand`, ensures the selected-card lift (`translateY(-14px)`) renders correctly — the card visually rises above the hand container's boundary and is clipped by the grandparent, not by the scroll container.

Wait — per spec, `overflow-y: visible` with `overflow-x: auto` computes to `overflow-y: auto`. This is actually unavoidable. The real fix is ensuring the `padding-top: 20px` on `.player-hand` is sufficient to contain the `-14px` lift without clipping. Currently it is (20px > 14px). So the existing code is correct for card visibility.

**Revised change:** Keep the existing PlayerHand mobile styles as-is. The 20px top padding already accommodates the 14px card lift. No change needed here.

### File: `src/frontend/component/game-ui/ActionPanel.vue`

No changes needed. The action panel's height is controlled by `var(--mobile-actions-height)` (56px) which is allocated in the grid. The fix to the viewport height calculation (using `dvh`) ensures this row is within the visible area.

---

## Edge Cases

1. **Firefox with URL bar visible vs hidden:** `100dvh` dynamically adjusts as the URL bar shows/hides during scroll. Since our element is `position: fixed`, it will resize smoothly. The grid's `1fr` row (table/play area) absorbs the size change.

2. **Landscape orientation on Firefox Android:** In landscape, viewport width typically exceeds 767px, so desktop layout applies. If width is still under 767px in landscape (unusual but possible on very small screens), `dvh` still works correctly.

3. **Browsers without `dvh` support:** The fallback `height: 100vh` applies. On Chrome Android, `100vh` with `position: fixed` already works correctly. On very old Firefox versions without `dvh` (< 108), the `100vh` fallback has the same URL bar issue, but these versions are < 2% of traffic and Firefox auto-updates aggressively.

4. **`overflow: clip` vs `overflow: hidden` with nested scroll:** The dual-declaration pattern means:
   - Browsers supporting `clip`: use `clip` (no scroll context, nested scroll works natively)
   - Browsers only supporting `hidden`: use `hidden` (creates scroll context, but `.game-board__hand { overflow: hidden }` creates an intermediate context that isolates the inner scroll)

5. **iPad Firefox (768px+ width):** Desktop layout, unaffected.

6. **PWA / fullscreen mode:** When the URL bar is absent (PWA or fullscreen API), `100dvh === 100vh === 100lvh`. No visual difference. Layout works identically to Chrome.

7. **Keyboard appearing (text input focus):** The game board has no text inputs during gameplay, so virtual keyboard does not appear. Not a concern for this screen.

8. **Safe area insets (notched phones):** The current layout does not use `env(safe-area-inset-*)`. On notched Firefox Android devices, the fixed positioning fills the full screen including under the notch. The 52px opponent row and 56px action row provide sufficient padding that content is not obscured. No change needed.

---

## Dependencies

- **LLD 11 (Mobile Layout):** Already implemented and deployed. This is a hotfix on top of that implementation.
- **No other LLDs or backend changes.**

---

## Test Requirements

### Manual Testing (Required)

| Device / Browser | Viewport | Verify |
|---|---|---|
| Firefox Android (151+) | 378x707 | All 4 grid rows visible; hand scrolls; play/pass buttons visible and tappable |
| Firefox Android (151+) | 378x707, URL bar visible | Actions row not pushed below fold |
| Firefox Android (151+) | 378x707, 13-card hand | Cards scroll horizontally; selected card rises without clipping |
| Chrome Android | 393x852 | No regression — layout identical to before fix |
| Chrome Android | 360x640 (small) | Actions visible, hand scrollable |
| Safari iOS | 375x667 | No regression — layout works as before |
| Desktop Chrome | 1920x1080 | Zero visual changes |
| Desktop Firefox | 1920x1080 | Zero visual changes |
| Desktop (any) | 767px width | Mobile layout activates correctly |
| Desktop (any) | 768px width | Desktop layout remains |

### Automated Tests (Playwright viewport emulation)

These tests should be added to the existing E2E suite:

1. **Firefox Android viewport simulation** (378x707):
   - `.game-board--mobile` class is present
   - `.game-board__actions` element is within viewport bounds (`boundingBox.y + boundingBox.height <= viewportHeight`)
   - Action buttons (play/pass) are visible and clickable (not occluded)
   - `.player-hand` is horizontally scrollable when cards exceed container width

2. **Regression: Chrome Android viewport** (393x852):
   - Same checks as above pass without the fix causing issues

3. **Viewport height respects dvh** (indirect):
   - The computed height of `.game-board--mobile` equals the viewport height (not larger)
   - Can verify via `element.getBoundingClientRect().height === window.innerHeight`

### Unit Tests

None needed — this is a CSS-only change with no logic modifications.

---

## Implementation Order

1. Edit `GameBoard.vue` scoped styles: add `dvh` height, `overflow` fallback, and `min-height: 0` on table
2. Edit `GameBoard.vue` scoped styles: add `overflow: hidden` to `.game-board--mobile .game-board__hand`
3. Test in Firefox Android DevTools responsive mode (378x707)
4. Test in Chrome Android DevTools responsive mode (393x852) — verify no regression
5. Test on real Firefox Android device if available
6. Deploy
