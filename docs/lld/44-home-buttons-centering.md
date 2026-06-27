# LLD 44: Home Buttons Centering Fix

## Scope

**Covers:** Fixing the centering of "Create Game" and "Join Game" buttons on the home page across all viewport widths.

**Does NOT cover:** Changes to other flow pages (login, signup, join, create, guest entry), button styling, or layout restructuring.

## Approach

The `.home` class in `HomeView.vue` has `max-width: 500px` and `text-align: center` but no explicit `width: 100%`. Inside `.flow-page` (a flex container with `justify-content: center`), the `.home` div shrinks to its content width rather than expanding to fill available space.

When content width happens to match the `max-width: 300px` of `.home__actions`, the `margin: 0 auto` on `.home__actions` becomes a no-op because there is no extra horizontal space within the parent to distribute.

**Fix:** Add `width: 100%` to the `.home` scoped style. This ensures the flex item expands to fill its container (capped at `max-width: 500px` by `justify-content: center` of the parent flex), giving `margin: 0 auto` on `.home__actions` the space it needs to center the buttons.

This is a single-property CSS addition with no structural changes.

## Frontend Design

Approved approach: single CSS fix in `HomeView.vue`. Add `width: 100%` to the `.home` class (which already has `max-width: 500px` and implicit centering via the parent flex container). No new components, no layout restructuring, no changes to other views.

### Change

In `src/frontend/component/HomeView.vue`, scoped styles:

```css
/* Before */
.home {
  text-align: center;
  max-width: 500px;
}

/* After */
.home {
  text-align: center;
  max-width: 500px;
  width: 100%;
}
```

### Why this works

- `.flow-page` is `display: flex; justify-content: center` -- it centers its children horizontally.
- With `width: 100%`, `.home` expands to fill the flex container (up to `max-width: 500px`).
- `.home__actions` has `max-width: 300px; margin: 0 auto` -- now it has 200px of parent width to center within.
- On narrow viewports (320px), `.home` is 100% of the available width (minus padding), so `.home__actions` at 300px still centers correctly within it.

### Regression check

Other flow pages (Login, Signup, CreateGame, JoinGame, GuestEntry) use `.form-card` inside `.flow-page`, not `.home`. The `.form-card` class already has `width: 100%`. This change is scoped to `HomeView.vue` only.

## Interfaces / Types

No changes to TypeScript interfaces or types. This is a CSS-only fix.

## State Model

No state changes. Pure presentational fix.

## Edge Cases

1. **Viewport 320px (smallest common mobile):** `.home` at 100% width = 320px - 32px padding = 288px. `.home__actions` at max-width 300px will shrink to 288px and remain centered (margin auto is 0 but alignment is still correct via text-align and flex).
2. **Viewport 375px (iPhone SE/Mini):** `.home` = 343px. `.home__actions` = 300px, margin auto centers with 21.5px on each side.
3. **Viewport 1440px+ (desktop):** `.home` capped at 500px by max-width, centered by parent flex. `.home__actions` = 300px, centered with 100px on each side.
4. **Signed-out state:** `.home__auth-prompt` also has `max-width: 300px; margin: 0 auto` -- same fix applies, buttons center correctly.

## Dependencies

None. This is a standalone CSS fix with no prerequisites.

## Test Requirements

**Manual verification (visual/responsive -- cannot be automated via unit tests):**

| Viewport | Check |
|----------|-------|
| 320px wide | Buttons horizontally centered |
| 375px wide | Buttons horizontally centered |
| 414px wide | Buttons horizontally centered |
| 768px wide | Buttons centered both axes |
| 1440px wide | Buttons centered both axes |

**Regression (manual):**

- Login, Signup, CreateGame, JoinGame, GuestEntry pages remain visually unchanged at 375px and 1024px viewports.

No automated tests required -- this is a single CSS property addition with no logic changes.
