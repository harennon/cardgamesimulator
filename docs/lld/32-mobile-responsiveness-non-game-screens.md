# LLD 32: Mobile Responsiveness for Non-Game Screens

## Scope

**Covers:**
- Mobile-responsive CSS for all pre-game and post-game screens: Home, Login, Guest Entry, Create Game, Join Game, Game Lobby, Game Over
- Touch-friendly sizing (44px minimum tap targets) on inputs and buttons
- Elimination of horizontal overflow on 375px viewports
- Bringing GuestEntryView into the shared `flows.css` form-card pattern

**Does NOT cover:**
- In-game board layout (covered by LLD 11)
- New features, navigation changes, or functional behavior
- Desktop layout changes (must remain identical at 768px+)
- Animations or transitions

---

## Approach

### Strategy: CSS Custom Property Overrides at a Single Breakpoint

Same pattern established in LLD 11. A single `@media (max-width: 767px)` block in `game-variables.css` overrides layout-related CSS custom properties. Components consume these variables in their scoped styles. No structural HTML changes needed (except GuestEntryView refactor to use `form-card` classes).

### Key Decisions

1. **Touch target compliance** -- All inputs get `min-height: 44px`; all buttons get `min-height: 48px` on mobile. Input `font-size` forced to `16px` to prevent iOS Safari auto-zoom on focus.

2. **Panel padding reduction** -- Desktop: `40px 48px` (current `--card-panel-padding`). Mobile: `28px 20px`. This reclaims ~56px of horizontal space on a 375px viewport.

3. **Full-width buttons** -- On mobile, action buttons become `width: 100%` for easy thumb reach. Game Over actions stack vertically instead of side-by-side.

4. **Remove min-width constraints** -- Lobby panel has `min-width: 360px` and Game Over panel has `min-width: 400px`. On mobile, these cause horizontal overflow. Override to `min-width: unset; width: calc(100% - 32px)` (16px margin each side).

5. **GuestEntryView refactor** -- Currently uses ad-hoc styles (`.guest-entry`, inline `form > div`). Refactor the template to use `flow-page` + `form-card` + `form-card__field` classes from `flows.css`, making it automatically benefit from the mobile overrides. Remove the entire `<style scoped>` block.

---

## Interfaces / Types

No TypeScript changes. This is purely CSS + one template refactor (GuestEntryView markup).

---

## Frontend Design

### CSS Variable Additions

Add to `game-variables.css` inside the existing `@media (max-width: 767px)` block:

```css
@media (max-width: 767px) {
  :root {
    /* Existing card sizing overrides stay as-is */

    /* Flow screen overrides */
    --card-panel-padding: 28px 20px;
    --page-max-width: 100%;
  }
}
```

### Mobile Overrides in `flows.css`

Append a mobile media query block to `flows.css`:

```css
@media (max-width: 767px) {
  .flow-page {
    padding: 24px 16px;
    align-items: flex-start;
    padding-top: 48px;
  }

  .form-card__input,
  .form-card__input[type="email"],
  .form-card__input[type="password"],
  .form-card__input[type="text"] {
    min-height: 44px;
    padding: 12px 14px;
    font-size: 16px; /* prevents iOS zoom */
  }

  .btn-primary,
  .btn-secondary {
    min-height: 48px;
    font-size: 16px;
  }
}
```

### GameLobbyView Mobile Overrides (scoped)

```css
@media (max-width: 767px) {
  .lobby__panel {
    min-width: unset;
    width: calc(100% - 32px);
    padding: 28px 20px;
  }

  .lobby__btn {
    min-height: 48px;
    font-size: 16px;
  }

  .lobby__btn--start {
    width: 100%;
  }

  .lobby__btn--copy {
    width: 100%;
  }

  .lobby__invite {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }
}
```

### GameOverView Mobile Overrides (scoped)

```css
@media (max-width: 767px) {
  .game-over__panel {
    min-width: unset;
    width: calc(100% - 32px);
    padding: 28px 20px;
  }

  .game-over__winner {
    font-size: 1.5rem;
  }

  .game-over__scores th,
  .game-over__scores td {
    padding: 6px 8px;
    font-size: 0.8rem;
  }

  .game-over__actions {
    flex-direction: column;
    width: 100%;
    gap: 10px;
  }

  .game-over__btn {
    width: 100%;
    min-height: 48px;
    font-size: 16px;
  }
}
```

### GuestEntryView Template Refactor

Replace the existing template with the `form-card` pattern:

```html
<template>
  <div class="flow-page">
    <form class="form-card" @submit.prevent="joinGame">
      <h2 class="form-card__title">Join as Guest</h2>

      <div class="form-card__field">
        <label class="form-card__label" for="display-name">Display Name</label>
        <input
          class="form-card__input"
          id="display-name"
          v-model="displayName"
          type="text"
          maxlength="20"
          required
          placeholder="Enter your name"
          :disabled="loading"
          data-testid="guest-name-input"
        />
      </div>

      <p v-if="errorMessage" class="form-card__error">{{ errorMessage }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="btn-primary"
        data-testid="guest-join-button"
      >
        {{ loading ? "Joining..." : "Join Game" }}
      </button>

      <div class="form-card__divider">or</div>

      <router-link :to="`/signup?redirect=/game/${gameId}`" class="btn-secondary">
        Sign up for stats &amp; history
      </router-link>

      <p class="form-card__footer">
        Already have an account?
        <router-link :to="`/login?redirect=/game/${gameId}`">Sign in</router-link>
      </p>
    </form>
  </div>
</template>
```

Remove the entire `<style scoped>` block from GuestEntryView -- it uses shared `flows.css` classes exclusively now.

### HomeView -- Already Mobile-Safe

HomeView uses `flow-page` wrapper, column flex layout, `max-width: 500px` with no `min-width`. The buttons are already full-width via `.home__actions` column layout. The only needed change is ensuring button min-height on mobile, which the `flows.css` media query handles for `.btn-primary` and `.btn-secondary`.

### View the Mockup

[`docs/mockups/mobile-responsiveness-non-game-screens.html`](https://github.com/harennon/cardgamesimulator/blob/lld-30-mobile-responsiveness-non-game-screens/docs/mockups/mobile-responsiveness-non-game-screens.html) on branch `lld-30-mobile-responsiveness-non-game-screens`

The mockup includes a viewport toggle (375px mobile vs 1024px desktop) and tabs for all screens.

---

## State Model

No state changes. All modifications are CSS-only (plus the GuestEntryView template refactor to use shared classes). No reactive state, no component props, no Vuex/Pinia involvement.

---

## Edge Cases

1. **iOS Safari auto-zoom on input focus** -- Mobile browsers zoom in when input font-size is below 16px. The override forces `font-size: 16px` on all `.form-card__input` elements at the mobile breakpoint.

2. **Lobby panel horizontal overflow** -- The `min-width: 360px` on `.lobby__panel` exceeds 375px viewport minus any body padding. The mobile override removes `min-width` and uses percentage-based width.

3. **Game Over table on 375px** -- Four columns can be tight. The mobile override reduces padding from `8px 12px` to `6px 8px` and font-size from `0.9rem` to `0.8rem`. Column headers abbreviate naturally with `text-overflow: ellipsis` if needed (but "Player", "Place", "Cards Left", "Points" fit at 0.75rem).

4. **GuestEntryView regression** -- The template refactor changes class names. Existing E2E tests use `data-testid` attributes (preserved), so they remain unaffected.

5. **Desktop regression** -- All overrides are inside `@media (max-width: 767px)`. Desktop users see zero changes. The `--card-panel-padding` and `--page-max-width` variable overrides only activate on mobile.

6. **Lobby `100vh` on mobile Safari** -- The `.lobby` container uses `height: 100vh` which on iOS Safari does not account for the address bar. This is acceptable for the lobby (content is centered and small); if it becomes an issue, a future fix can use `min-height: 100dvh` (already well-supported).

7. **`.btn-secondary` as router-link** -- The GuestEntryView "Sign up" link renders as an `<a>` tag with `.btn-secondary`. The `min-height: 48px` override also applies to anchor tags because the selector targets the class, not the element type. Add `display: flex; align-items: center; justify-content: center;` to ensure vertical centering in the link variant.

---

## Dependencies

- **LLD 11 (Mobile Layout)** -- Establishes the CSS custom property + media query pattern this LLD follows
- **LLD 06.7 (Frontend Flows UI)** -- Created the `flows.css` shared styles and the form-card pattern
- **`src/frontend/styles/game-variables.css`** -- Where mobile variable overrides live
- **`src/frontend/styles/flows.css`** -- Where shared form/button styles live
- No backend changes required

---

## Test Requirements

### Visual Verification (Manual)

| Viewport | Checks |
|----------|--------|
| 375x667 (iPhone SE) | All 7 screens render without horizontal overflow; all buttons/inputs meet 44px+ height; no content cut off |
| 390x844 (iPhone 14) | Same checks, verify adequate spacing |
| 768x1024 (iPad portrait) | Desktop layout applies (no mobile overrides active) |
| 1024px+ desktop | Zero visual regression on any screen |

### Per-Screen Checks

- **Home** -- Buttons tall enough for thumb tap, text readable
- **Login / Signup** -- Inputs don't trigger iOS zoom, error message visible
- **Guest Entry** -- Visually consistent with Login/Join (uses same form-card pattern now)
- **Create Game** -- Select dropdowns usable, range slider thumb reachable
- **Join Game** -- Code input large enough, uppercase transform works
- **Game Lobby** -- Panel doesn't overflow, room code chip readable, start button full-width
- **Game Over** -- Score table fits without horizontal scroll, actions stacked vertically

### Automated Tests

- **Existing E2E tests pass** -- GuestEntryView template refactor preserves all `data-testid` attributes. Run existing E2E suite to confirm no regression.
- **No new unit tests needed** -- No logic changes, only CSS and template class adjustments.

### E2E (Optional, if Playwright viewport emulation available)

- Set viewport to 375x667, navigate each screen, assert no horizontal scrollbar (`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)
- Verify `.lobby__panel` has no `min-width` computed style forcing overflow
- Verify all buttons have computed height >= 44px

---

## Implementation Order

1. Add mobile variable overrides to `game-variables.css` (`--card-panel-padding`, `--page-max-width`)
2. Add mobile media query block to `flows.css` (input min-height, button min-height, font-size, padding)
3. Refactor `GuestEntryView.vue` template to use `form-card` pattern; remove `<style scoped>` block
4. Add mobile media query to `GameLobbyView.vue` scoped styles (remove min-width, adjust padding/button sizing)
5. Add mobile media query to `GameOverView.vue` scoped styles (remove min-width, stack actions, adjust table)
6. Add `display: flex; align-items: center; justify-content: center;` to `.btn-secondary` in `flows.css` mobile block for link buttons
7. Verify on 375px viewport in dev tools -- all 7 screens
8. Run existing E2E tests to confirm no regression
