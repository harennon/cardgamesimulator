# LLD 11: Mobile Layout (Stacked Compact)

## Scope

**Covers:**
- Responsive CSS layout that transforms the game board into a mobile-optimized stacked grid on narrow viewports
- Mobile-specific card sizing, overlap, and scroll behavior for the player hand
- Compact opponent strip (pill badges instead of card-back visuals)
- Game log slide-in drawer (replacing the always-visible sidebar)
- Touch-friendly interaction targets (44px minimum)

**Does NOT cover:**
- Tap-hold + drag range-select (future enhancement)
- Lobby, game-over, or guest-entry screen mobile layouts (separate effort)
- Desktop layout changes (must remain identical)
- Game logic or state management changes (purely presentational)

---

## Approach

### Strategy: CSS Custom Properties + Media Query Override

Apply mobile layout via a single `@media (max-width: 767px)` breakpoint. The PRIMARY mechanism for mobile overrides is **CSS custom properties defined at `:root` level** — child components consume these variables in their scoped styles, and the media query overrides the variable values. This eliminates all specificity wars between unscoped parent selectors and scoped child styles.

**Why not unscoped parent selectors?** Vue's scoped styles compile to `.card--selected[data-v-xxx]`. An unscoped parent selector like `.game-board--mobile .card--selected` has LOWER specificity than the scoped version (attribute selectors add specificity). CSS custom properties bypass this entirely — the variable value changes at `:root`, and the scoped rule that consumes it automatically reflects the new value.

**What unscoped styles are for:** Only the log drawer and toggle button (which live directly in GameBoard.vue, not inside child components) use unscoped styles. These elements don't exist in any child component, so there's no specificity conflict.

**Rationale:** The mockup uses the exact same HTML structure (opponents, table, hand, actions) — only sizing and grid arrangement differ. CSS variables + media query approach minimizes code duplication and avoids splitting component logic.

### Breakpoint Choice: 767px

- Below 768px activates mobile layout
- Covers all phones in portrait (iPhone SE 375px through iPhone 15 Pro Max 430px)
- Tablets in portrait (768px+) keep desktop layout — their screen size is adequate
- No intermediate "tablet" breakpoint needed for v1

### Critical CSS Decisions (from prototyping)

These were discovered during mockup development and are non-negotiable:

1. **`overflow: clip` on `.game-board`** — NOT `overflow: hidden`. `overflow: clip` clips overflow without establishing a scroll context (unlike `hidden` which does). This is critical because nested `overflow-x: auto` on the player hand MUST work inside the clipped parent. If the parent used `overflow: hidden`, it would create a scroll context that interferes with the child's scrolling behavior.

2. **No `overflow-x: hidden` on the hand zone** — CSS spec says: if one axis is `hidden`, the other becomes `auto`. This would clip selected cards that rise above the container via `translateY`. Instead, use `min-width: 0` on the grid cell to constrain width.

3. **`grid-template-columns: minmax(0, 1fr)` combined with `min-width: 0` on grid cells** — Both are needed together. The `minmax(0, 1fr)` constrains width at the track level (preventing the column from growing beyond viewport). The `min-width: 0` on direct children overrides the CSS Grid default of `min-width: auto` (which allows content to expand cells beyond the track). Without BOTH, content can push the grid wider than the viewport on narrow screens.

---

## Interfaces / Types

No new TypeScript types are needed. This is a CSS-only change with one small Vue template addition (drawer toggle button + drawer wrapper).

### New Vue Reactive State

```typescript
// In GameBoard.vue <script setup>
const isMobile = ref(false);        // Tracks current viewport for template logic
const logDrawerOpen = ref(false);   // Controls drawer visibility

// Lifecycle: matchMedia listener with proper cleanup
const mql = window.matchMedia('(max-width: 767px)');
const handleMediaChange = (e: MediaQueryListEvent) => { isMobile.value = e.matches; };

onMounted(() => {
  isMobile.value = mql.matches;
  mql.addEventListener('change', handleMediaChange);
});

onUnmounted(() => {
  mql.removeEventListener('change', handleMediaChange);
});

// Escape key closes drawer
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') logDrawerOpen.value = false;
}

watch(logDrawerOpen, (open) => {
  if (open) {
    document.addEventListener('keydown', onKeydown);
  } else {
    document.removeEventListener('keydown', onKeydown);
  }
});
```

### New Props (none needed)

GameCard already accepts `size` prop (`"small" | "medium" | "large"`). On mobile, card sizing is controlled entirely via CSS custom properties — no new prop values needed.

**Decision: CSS variable approach.** Components use `var(--card-hand-width)` etc. in their scoped styles. The mobile media query overrides these variables at `:root`. Components don't need to know about mobile.

---

## Component Changes

### GameBoard.vue

**Template changes:**
- Add `:class="{ 'game-board--mobile': isMobile }"` to root div
- Add hand label `<div class="game-board__hand-label">Your hand ({{ gameState.you.hand.length }})</div>` above the PlayerHand component
- Move `<GameLog>` into a `<Teleport to="body">` drawer wrapper (conditionally rendered when mobile)
- Add log drawer toggle button (visible only on mobile)

**Script changes:**
- Add `isMobile` and `logDrawerOpen` refs
- Add `matchMedia` listener with stored handler reference and proper cleanup
- Add Escape key handler for drawer close
- Add `watch(logDrawerOpen)` for keydown listener management

**Style changes:**
- Add unscoped `<style>` block ONLY for log drawer + toggle (these don't live in child components)
- Add mobile grid override in scoped styles (`.game-board--mobile` class on root element works within scoped styles)

### PlayerHand.vue

**Style changes (scoped, using CSS variables):**
- Replace hardcoded `-20px` overlap with `var(--card-overlap)`
- Replace hardcoded hover transform with `var(--card-hover-lift)`
- Replace hardcoded selected+hover transform with calculation from variables
- Add `width: 100%` in mobile (via the variable-driven approach or a mobile-specific rule using `:root` variable as a signal)

The component's scoped styles consume variables; the media query at `:root` level changes them.

### GameCard.vue

**Style changes (scoped, using CSS variables):**
- Replace hardcoded `64px`/`90px` in `.card--medium` and `.card--large` with `var(--card-hand-width)` and `var(--card-hand-height)`
- Replace hardcoded `translateY(-20px)` in `.card--selected` with `var(--card-selected-lift)`
- These variables have desktop defaults in `game-variables.css` and mobile overrides in the media query

### OpponentRow.vue

**Style changes (mobile media query, using variables where applicable):**
- Hide `.opponent__cards` (card-back visuals) — show only name + count as pills
- Layout changes to horizontal pills with flex-wrap
- Name truncation: `max-width: 60px; overflow: hidden; text-overflow: ellipsis`
- Active indicator: gold border on pill + pulsing dot
- Gap reduced from 24px to 2px
- Height constrained to 52px total (including padding)

### ActionPanel.vue

**Style changes (mobile media query):**
- Button padding: `10px 28px` (already correct for mobile touch targets)
- Row height: 56px
- Font size: `0.85rem`

### GameLog.vue

**No changes to the component itself.** On mobile, it renders inside a drawer wrapper.

### New: Log Drawer (inline in GameBoard.vue)

```html
<!-- Mobile log drawer -->
<Teleport to="body">
  <div v-if="isMobile" class="log-drawer" :class="{ 'log-drawer--open': logDrawerOpen }">
    <div class="log-drawer__header">
      <span>Game Log</span>
      <button class="log-drawer__close" @click="logDrawerOpen = false">&times;</button>
    </div>
    <GameLog :entries="big2State?.playHistory ?? []" />
  </div>
</Teleport>

<!-- Toggle button -->
<button
  v-if="isMobile"
  class="log-toggle"
  aria-label="Open game log"
  @click="logDrawerOpen = !logDrawerOpen"
>
  &#9776;
</button>
```

---

## State Model

No game state changes. All state is purely UI-local:

| State | Type | Persisted? | Purpose |
|-------|------|-----------|---------|
| `isMobile` | `ref<boolean>` | No | Drives CSS class + conditional template rendering |
| `logDrawerOpen` | `ref<boolean>` | No | Controls drawer slide-in |

State resets on page load — no persistence needed.

---

## CSS Variable Additions

Add to `src/frontend/styles/game-variables.css` inside the existing `:root` block:

```css
/* Card sizing tokens (desktop defaults) */
--card-hand-width: 64px;
--card-hand-height: 90px;
--card-play-width: 64px;
--card-play-height: 90px;
--card-overlap: -20px;
--card-selected-lift: -20px;
--card-hover-lift: -8px;
--card-selected-hover-lift: -24px;

/* Mobile layout tokens (used by grid/spacing) */
--mobile-rim-width: 4px;
--mobile-opponent-height: 52px;
--mobile-hand-height: 160px;
--mobile-actions-height: 56px;
```

Then at the end of the file, OUTSIDE `:root`, add the mobile override:

```css
@media (max-width: 767px) {
  :root {
    --card-hand-width: 52px;
    --card-hand-height: 73px;
    --card-play-width: 48px;
    --card-play-height: 68px;
    --card-overlap: -18px;
    --card-selected-lift: -14px;
    --card-hover-lift: 0px;
    --card-selected-hover-lift: -14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --drawer-transition: none;
  }
}
```

**Note:** The `--mobile-breakpoint` variable has been intentionally omitted. CSS custom properties CANNOT be used inside `@media` query expressions — they only resolve in property values. Including it would mislead the implementer into thinking `@media (max-width: var(--mobile-breakpoint))` is valid (it is not). Use the raw `767px` value in all media queries.

---

## Detailed CSS Specification

### GameBoard Mobile Grid (scoped styles)

```css
@media (max-width: 767px) {
  .game-board--mobile {
    grid-template-rows: var(--mobile-opponent-height) 1fr var(--mobile-hand-height) var(--mobile-actions-height);
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "opponents"
      "table"
      "hand"
      "actions";
    overflow: clip;
  }

  .game-board--mobile::after {
    border-width: var(--mobile-rim-width);
  }

  .game-board--mobile > * {
    min-width: 0;
  }

  .game-board--mobile .game-board__log {
    display: none;
  }

  .game-board--mobile .game-board__hand {
    flex-direction: column;
    align-items: flex-start;
  }
}
```

### Hand Label (scoped in GameBoard.vue)

```css
.game-board__hand-label {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding-left: 12px;
  margin-bottom: 2px;
}
```

### Opponent Strip Mobile (scoped in OpponentRow.vue)

```css
@media (max-width: 767px) {
  .opponent-row {
    gap: 2px;
    padding: 6px 8px;
    border-bottom-width: 1.5px;
  }

  .opponent {
    flex-direction: row;
    padding: 4px 10px;
    border-radius: 16px;
    border-width: 1.5px;
  }

  .opponent__cards {
    display: none;
  }

  .opponent__name {
    font-size: 0.72rem;
    max-width: 60px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .opponent__count {
    font-size: 0.65rem;
    background: rgba(0, 0, 0, 0.3);
    padding: 1px 5px;
    border-radius: 8px;
  }

  .opponent__dot {
    /* Pulsing active indicator - see prefers-reduced-motion below */
  }
}
```

### Player Hand (scoped in PlayerHand.vue, variable-driven)

The component's scoped styles use CSS variables for all values that change on mobile:

```css
/* In PlayerHand.vue <style scoped> — existing rules updated to use variables */
.player-hand {
  display: flex;
  align-items: flex-end;
  padding: 8px 16px;
  overflow-x: auto;
}

.player-hand__card {
  margin-left: var(--card-overlap);
  cursor: default;
}

.player-hand__card--first {
  margin-left: 0;
}

.player-hand__card--interactive {
  cursor: pointer;
}

.player-hand__card--interactive:hover {
  transform: translateY(var(--card-hover-lift));
}

.player-hand__card--interactive.player-hand__card:global(.card--selected):hover {
  transform: translateY(var(--card-selected-hover-lift));
}

/* Mobile-specific additions */
@media (max-width: 767px) {
  .player-hand {
    width: 100%;
    padding: 20px 12px 4px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    scrollbar-width: none;
  }

  .player-hand::-webkit-scrollbar {
    display: none;
  }
}
```

**Key detail: `width: 100%` on `.player-hand` in mobile.** Without this, the flex container does not constrain to the grid cell width. The grid cell has `min-width: 0` and the column is `minmax(0, 1fr)`, but the child still needs explicit `width: 100%` to respect the available space as its basis for overflow scrolling.

### Card Sizing (scoped in GameCard.vue, variable-driven)

```css
/* In GameCard.vue <style scoped> — .card--medium and .card--large updated */
.card--large,
.card--medium {
  width: var(--card-hand-width);
  height: var(--card-hand-height);
  font-size: 1rem;
}

.card--selected {
  transform: translateY(var(--card-selected-lift));
  box-shadow:
    0 8px 24px var(--gold-glow),
    3px 6px 16px var(--card-shadow);
  border-color: var(--gold-accent);
}
```

On mobile, `--card-hand-width` resolves to `52px`, `--card-hand-height` to `73px`, `--card-selected-lift` to `-14px` — no specificity battle, no unscoped selectors needed.

### Play Area Card Sizing

For cards in the play area (last play display), add a scoped rule in PlayArea.vue:

```css
.play-area__card-row .card {
  width: var(--card-play-width);
  height: var(--card-play-height);
}
```

### Log Drawer (unscoped in GameBoard.vue)

These styles are unscoped because the drawer is teleported to `<body>` and does not live inside any child component:

```css
.log-toggle {
  position: fixed;
  top: 60px;
  right: 8px;
  z-index: 200;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--panel-bg);
  border: 1.5px solid var(--text-muted);
  color: var(--text-primary);
  font-size: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.log-toggle:active {
  background: rgba(201, 168, 76, 0.2);
  border-color: var(--gold-accent);
}

.log-drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: 280px;
  height: 100%;
  z-index: 300;
  background: var(--panel-bg);
  border-left: 1.5px solid var(--table-rim-light);
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(8px);
  transform: translateX(100%);
  transition: transform 0.25s ease;
}

.log-drawer--open {
  transform: translateX(0);
}

.log-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  font-family: var(--font-ui);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--table-rim-light);
}

.log-drawer__close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.4rem;
  cursor: pointer;
  padding: 4px 8px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

**Animation approach:** The drawer uses `transform: translateX(100%)` (off-screen) to `translateX(0)` (visible). This is GPU-composited — only the composite step runs each frame, no layout reflow. The previous `right: -280px` to `right: 0` approach triggers layout recalculation every frame, which is visibly janky on low-end phones.

### Accessibility: prefers-reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
  .opponent__dot {
    animation: none;
  }

  .log-drawer {
    transition: none;
  }

  .turn-banner {
    animation: none;
  }
}
```

This respects user preferences for reduced motion. The pulsing active-player dot, drawer slide animation, and turn banner all disable their animations when the user has requested reduced motion at the OS level.

---

## Edge Cases

1. **Viewport meta tag:** `<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">` must be set in `index.html`. Prevents pinch-zoom which conflicts with card selection gestures. Already present (verify).

2. **Safari address bar resize:** Using `position: fixed; inset: 0` instead of `100vh` avoids the iOS Safari dynamic viewport height issue (address bar appearing/disappearing causes layout shift). The grid with fixed inset handles this correctly.

3. **13 cards overflow:** With 52px cards and -18px overlap, 13 cards need `52 + (12 * 34) = 460px` width. On a 375px screen, this overflows — the horizontal scroll handles it. The 20px top padding in the scroll container ensures selected cards (with -14px lift) remain visible.

4. **Orientation change:** The media query re-evaluates on orientation change. In landscape on phone, width typically exceeds 767px, so desktop layout applies. This is acceptable — landscape phones have enough width.

5. **Log drawer + game actions:** Drawer is z-index 300 (above everything). Toggle button is z-index 200. These don't interfere with game-board z-index structure (max 100 for rim).

6. **`:active` vs `:hover` on mobile:** Mobile browsers simulate hover on tap, causing sticky hover states. The mobile override sets `--card-hover-lift: 0px`, which means the `:hover` rule in PlayerHand still exists in the CSS but does nothing visible (`translateY(0px)` is identity). Card selection feedback uses `:active` and the Vue-driven `.card--selected` class.

7. **Desktop remains unchanged:** The `game-board--mobile` class only applies when `isMobile` is true (matchMedia). All mobile CSS is scoped inside `@media (max-width: 767px)`. CSS variable overrides only take effect inside the media query. Double-gating prevents any accidental desktop regression.

8. **Scoped styles + CSS variable bridge:** Instead of using `:deep()` or unscoped parent selectors to override child component styles, ALL cross-component overrides use CSS custom properties. The child component's scoped rule says `width: var(--card-hand-width)`, and the global media query changes that variable's value. This is the Vue-recommended pattern for parent layout influence without specificity conflicts.

9. **Drawer backdrop:** No backdrop overlay in v1 — the drawer slides over the game without dimming. Simplifies implementation and avoids tap-target confusion. User closes via the X button, tapping the toggle again, or pressing Escape.

10. **Player finishes (empty hand):** When a player has 0 cards and is showing the "Finished — waiting for others" message, the hand zone height (160px) is still reserved. The message displays centered in that zone. No layout shift.

11. **Escape key closes drawer:** Standard UX pattern. A `keydown` listener is added when the drawer opens and removed when it closes (via `watch`). This avoids a permanent global listener.

---

## Dependencies

- **LLD 6: Frontend Game UI** — all components being modified were created by this LLD
- **Approved mockup** — `design-mockups/mobile-a-stacked-compact.html` (design reference)
- **No backend changes** — purely frontend/CSS

---

## Test Requirements

### Visual Verification (Manual)

Since this is purely CSS/layout, automated unit tests provide minimal value. Testing is primarily manual:

- [ ] iPhone SE (375x667) — all zones visible, no overflow, hand scrollable
- [ ] iPhone 14 Pro (393x852) — same checks, more vertical space in play area
- [ ] Android Chrome (360px typical) — same checks
- [ ] Firefox Mobile — verify `overflow: clip` works (the key cross-browser concern)
- [ ] Safari iOS — verify fixed positioning + no address bar jump
- [ ] Desktop at 768px+ — verify ZERO visual changes
- [ ] Desktop at 767px — verify mobile layout activates cleanly
- [ ] 13-card hand — verify horizontal scroll works, selected cards visible above
- [ ] 1-card hand — verify no awkward centering/sizing
- [ ] Log drawer open/close — smooth animation via transform, no jank
- [ ] Orientation change — landscape reverts to desktop layout
- [ ] Escape key — closes drawer when open
- [ ] prefers-reduced-motion — animations disabled when OS setting is on

### Unit Tests (Minimal)

- `isMobile` ref correctly reflects matchMedia state (mock matchMedia in test)
- `logDrawerOpen` toggles correctly
- Log drawer renders inside Teleport when isMobile is true
- Log drawer toggle button only renders when isMobile is true
- Desktop layout (isMobile=false) does not have `game-board--mobile` class
- Escape key closes drawer when open
- matchMedia listener is cleaned up on unmount

### E2E Tests (Optional, if Playwright viewport emulation is set up)

- Set viewport to 375x667, verify `.game-board--mobile` class present
- Verify `.game-board__log` is `display: none`
- Verify log toggle button is visible
- Click toggle, verify drawer opens
- Press Escape, verify drawer closes
- Verify hand cards are scrollable (scrollWidth > clientWidth with 13 cards)

---

## Implementation Order

1. Add CSS variables to `game-variables.css` (desktop defaults in `:root`, mobile overrides in `@media` block, `prefers-reduced-motion` block)
2. Update GameCard.vue scoped styles to use `var(--card-hand-width)`, `var(--card-hand-height)`, `var(--card-selected-lift)` instead of hardcoded values
3. Update PlayerHand.vue scoped styles to use `var(--card-overlap)`, `var(--card-hover-lift)`, `var(--card-selected-hover-lift)` — add mobile `width: 100%` + scroll rules
4. Add `isMobile` + `logDrawerOpen` reactive state to GameBoard.vue (with full matchMedia lifecycle + Escape key handler)
5. Add `game-board--mobile` class binding and mobile grid override (scoped styles)
6. Add hand label template + styles
7. Add log drawer template + toggle button (mobile only) + unscoped styles for drawer/toggle
8. Add mobile media query overrides in OpponentRow.vue and ActionPanel.vue (scoped)
9. Verify on mobile viewport in dev tools
10. Test on real devices (iOS Safari, Android Chrome, Firefox Mobile)
