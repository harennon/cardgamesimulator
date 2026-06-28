# LLD 58: Signed-in home page overflows viewport; content not vertically centered

## Scope

**Covers:**

- The vertical-centering / viewport-overflow bug on the signed-in home page (`/`, the "Welcome back, $user" view), caused by `.flow-page` claiming a full `100vh` while sitting as a flex child *beneath* the signed-in nav bar in `.app-shell`.
- A related signed-out button-width inconsistency on the home page (the "Sign Up" secondary action renders narrower than the full-width "Log In" primary).

**Does NOT cover:**

- The horizontal-centering fix already shipped in LLD 44 (#46 / PR #53) — that is correct and is left untouched.
- Mobile join-game scroll behavior (#63). The same `.flow-page` double-`100vh` is a contributing root cause there; this LLD makes the structural fix and uses dynamic-viewport-safe sizing where it touches the mobile media query so that the #63 follow-up is trivial, but #63's own scope (mobile join layout) is explicitly out of scope here.
- In-game screens (`/game/:gameId`, including lobby and game-over), which render with `showNav === false`, do not use `.flow-page`, and use their own `.lobby` / `.game-over` layout. They are out of scope and verified-unaffected.
- Any TypeScript, routing, auth, or game-logic change. This is CSS-only plus the existing template class bindings.

## Approach

### Root cause

`App.vue`'s `.app-shell` is a full-height flex column:

```css
.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
```

When signed in (`showNav === true`), it stacks the `.app-nav` bar (~49px, height depends on font load) above `<router-view />`. The router view for `/` is `HomeView`, whose root is `.flow-page`:

```css
.flow-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
```

Because `.flow-page` re-asserts a second `100vh`, the column's total content height becomes `navHeight + 100vh`, which:

1. **Overflows the viewport** by roughly the nav height → stray vertical scrollbar on a screen that should fit.
2. **Reads as off-center** — content is centered inside the 100vh `.flow-page` box, but that box is itself pushed down by the nav, so relative to the actual visible area the content sits above true center.

Signed out, there is no nav, so `.flow-page` ≈ viewport and the bug does not appear — which is why earlier triage (rendered logged-out) concluded the page was already centered.

### Fix (Option A — user-approved, no magic numbers)

Replace `.flow-page`'s `min-height: 100vh` with flex-fill semantics so it consumes exactly the leftover height inside the already-flex `.app-shell` column:

```css
.flow-page {
  flex: 1;
  min-height: 0;
  /* display:flex; align-items:center; justify-content:center; padding unchanged */
}
```

- `.app-shell` is already `display: flex; flex-direction: column`, so a `flex: 1` child grows to `viewport − navHeight` and centers content in exactly the visible area.
- `min-height: 0` is required so the flex item can shrink below its content's intrinsic size; this is what allows tall content to scroll internally rather than forcing the column (and thus the page) taller.
- Resilient to nav-height changes from font load, wrapping, or future nav content — nothing hard-codes the nav height.
- Identical behavior signed-out: the shell has no nav, so the single `flex: 1` child fills 100% of `.app-shell` (which is `min-height: 100vh`) — same visual result as before.

**Option B rejected:** `min-height: calc(100vh − <navHeight>)` was explicitly NOT chosen — it hard-codes the nav height and drifts whenever the nav reflows (e.g., long display name wraps, font swap changes line height).

### Dynamic-viewport safety (touches mobile only)

Where the fix interacts with the existing mobile media query, prefer dynamic/small-viewport units over `100vh` for any height the page falls back to, so iOS Safari's collapsing address bar does not reintroduce overflow and so the #63 follow-up is trivial. Specifically, keep `.app-shell` driving height; the desktop `.flow-page` rule introduces no `vh` of its own (it uses `flex: 1`). No new `vh` is added by this LLD. (Note: `.app-shell` retains `min-height: 100vh` in `App.vue`; changing it to `100dvh` is a separate, optional follow-up and is not required for this fix.)

### Mobile media query reconciliation

The existing rule top-aligns and pads all flow pages on mobile:

```css
@media (max-width: 767px) {
  .flow-page { padding: 24px 16px; align-items: flex-start; padding-top: 48px; }
}
```

With Option A the overflow is gone regardless of alignment. The intent of `align-items: flex-start` is to keep **tall forms** (login/signup/create) top-aligned so their top doesn't get clipped or pushed off-screen when they exceed viewport height. The short signed-in/signed-out home screen, however, looks best centered.

**Decision:** Scope the mobile top-align to the form screens, and let the short home screen center on mobile too. Implement by overriding alignment for the home surface only:

```css
@media (max-width: 767px) {
  .flow-page { padding: 24px 16px; align-items: flex-start; padding-top: 48px; }
  /* Home is short; center it. Tall forms keep flex-start so they don't clip. */
  .flow-page:has(.home) { align-items: center; padding-top: 24px; }
}
```

`:has()` is supported in all current evergreen mobile browsers (Safari 15.4+, Chrome/Android 105+). **Fallback if broader support is required:** add a modifier class `flow-page--center` to `HomeView`'s root (`<div class="flow-page flow-page--center">`) and target that instead of `:has()`. The implementer should prefer the explicit modifier class — it is more robust and does not depend on `:has()` support. The LLD's required behavior is: home centers on mobile, tall forms stay top-aligned; the selector mechanism is the implementer's choice between `:has()` and a modifier class, with the modifier class recommended.

### Button-width fix (signed-out home)

In `HomeView.vue`, the signed-out `.home__auth-prompt` is a centered flex column. `.btn-primary` ("Log In") has `width: 100%`; `.btn-secondary` ("Sign Up") is `display: inline-block` with no width, so it shrinks to its text and reads narrower than the primary. The signed-in `.home__actions` pair already stretches because `.home__actions` has `width: 100%` and the column children inherit full width via the primary; the secondary there is also `inline-block` but the visual mismatch is most pronounced in the auth prompt.

**Fix:** Force the action buttons to full column width in both action containers, in `HomeView.vue` scoped styles:

```css
.home__btn { width: 100%; }
```

`.home__btn` is already applied to all four buttons (Create/Join and Log In/Sign Up) and already sets `display: block`. Adding `width: 100%` makes primary and secondary share the same column width in both states. This overrides the shared `.btn-secondary { display: inline-block }` width behavior locally without touching the shared `flows.css` button rule (which other forms rely on).

## Frontend Design

**Approved direction:** Option A + button fix. Approved mockup:
`https://harennon.github.io/cardgamesimulator/signed-in-home-page-vertical-centering.html`
(source: `docs/mockups/signed-in-home-page-vertical-centering.html` on branch `lld-56-signed-in-home-page-vertical-centering`). Do not re-explore alternatives.

**Visual outcome (per mockup):**

- Signed-in home: title, "Welcome back, $user", and the Create Game / Join Game pair are vertically centered in the area below the nav, with no page scrollbar, at both 375×667 and 1440×900.
- Signed-out home: title, description, and the Log In / Sign Up pair centered with no scrollbar; the two buttons are the **same width** (both full column width, capped by `.home__actions` / `.home__auth-prompt` `max-width: 300px`).
- All other flow screens (Login, Signup, CreateGame, JoinGame, GuestEntry) remain visually centered when short, and scroll internally (no page-level overflow that traps content) when their form exceeds the visible area.

**Mechanism summary:**

| Element | Before | After |
| --- | --- | --- |
| `.flow-page` (flows.css) | `min-height: 100vh` | `flex: 1; min-height: 0` |
| `.flow-page` mobile align | `align-items: flex-start` for all | top-align tall forms; center home (modifier class or `:has`) |
| `.home__btn` (HomeView.vue) | no width (secondary shrinks) | `width: 100%` |

## Interfaces / Types

None. No TypeScript interfaces, props, composables, routes, or state shapes change. CSS-only, plus an optional `flow-page--center` modifier class on `HomeView`'s root element (template class string change only).

## State Model

No state changes. Purely presentational. Nothing persisted, nothing added to in-memory or client reactive state. `App.vue`'s `showNav` / `isAuthenticated` reactive values are unchanged and continue to drive whether the nav renders.

## Edge Cases

1. **Signed in, short content (home), desktop 1440×900:** `.flow-page` = `viewport − navHeight`; content centers in visible area; page height == viewport (no scrollbar). Was 954 > 900; now == 900.
2. **Signed in, mobile 375×667:** same; was 721 > 667; now == 667. Content centered (home centered per mobile override).
3. **Signed out, any viewport:** no nav; `.flow-page` is the sole `flex: 1` child of a `min-height: 100vh` shell → fills 100%; identical to prior centered behavior. No regression.
4. **Tall form exceeds viewport (e.g., Signup on a short/landscape phone):** `min-height: 0` lets `.flow-page` shrink to the available column space; its content overflows and the page scrolls to reveal the form. The mobile `align-items: flex-start` keeps the form's top reachable (not clipped above the fold). Must verify the form's top is reachable and the submit button is scrollable into view.
5. **Long display name in nav (wrap → taller nav):** nav grows; `.flow-page` (`flex: 1`) automatically shrinks; still no overflow. This is the explicit advantage of Option A over Option B.
6. **Font swap / FOUT changes nav height after load:** layout reflows but stays correct because no nav height is hard-coded.
7. **`:has()` unsupported (older mobile browser), if `:has()` chosen over modifier class:** home falls back to mobile `flex-start` top-align — still no overflow, just top-aligned instead of centered (acceptable degradation). Mitigated entirely by preferring the `flow-page--center` modifier class.
8. **Signed-out button widths at 320px:** both buttons at `width: 100%` inside `.home__auth-prompt` (`max-width: 300px`, shrinks to ~288px) — equal width, centered.
9. **Other flow surfaces (Login/CreateGame/JoinGame/GuestEntry):** `.form-card` already has `width: 100%`; the `.flow-page` change only affects vertical fill, so these remain centered (short) and scroll (tall). Verify each.
10. **In-game lobby / game-over (`/game/:gameId`):** `showNav === false`, no nav, and these use `.lobby` / `.game-over`, not `.flow-page` — unaffected. Confirmed via source (`GameLobbyView.vue`, `GameOverView.vue`).

## Dependencies

- **LLD 44 (home buttons centering)** — provides the existing `.home` / `.home__actions` / `.home__auth-prompt` horizontal-centering structure this builds on. Must remain intact.
- **LLD 11 (mobile layout)** — establishes the `767px` breakpoint convention reused here. No game-board changes.
- **`App.vue`** — relies on existing `.app-shell { display: flex; flex-direction: column; min-height: 100vh }` and `showNav` behavior; no change required to `App.vue` for the fix to work.
- Approved mockup (above). No backend or shared-package dependency.

## Test Requirements

This is a CSS/layout fix; the testing-principles doc (heuristic 6) permits a manual table for genuine visual/responsive verification that computed-state assertions can't cover. Bias remains toward any cheap automated check.

### Automated (DOM/E2E, if Playwright viewport emulation available)

1. Signed in at 1440×900 on `/`: assert `document.documentElement.scrollHeight <= window.innerHeight` (no vertical overflow).
2. Signed in at 375×667 on `/`: same no-overflow assertion.
3. Signed out at 1440×900 and 375×667 on `/`: same no-overflow assertion (regression guard).
4. Signed out on `/`: assert the rendered widths of the "Log In" and "Sign Up" links are equal (`getBoundingClientRect().width` within 1px).
5. Regression: for Login and Signup at 1440×900, assert no horizontal overflow and the form card is present and centered.

### Manual (visual — cannot be fully asserted via computed state)

| State | Viewport | Check |
| --- | --- | --- |
| Signed in | 375×667 | Home content vertically centered in visible area; no scrollbar |
| Signed in | 1440×900 | Home content vertically centered; no scrollbar |
| Signed out | 375×667 | Content centered; Log In / Sign Up equal width; no scrollbar |
| Signed out | 1440×900 | Same |
| Login (tall) | 375×667 landscape / short height | Form top reachable; scrolls to submit; not clipped above fold |
| Signup (tall) | 375×667 | Form top-aligned, scrollable, submit reachable |
| CreateGame | 1440×900 | Card centered, no overflow |
| JoinGame | 375×667 & 1440×900 | Card reachable, no page-trapping overflow |
| GuestEntry | 375×667 | Card centered/top-aligned per height, no overflow |
| In-game lobby & game-over | 375×667 & 1440×900 | Visually unchanged (regression: not on `.flow-page`) |

### Out of scope but keep in view

- Mobile join-game scroll (#63): verify the fix does not worsen it; prefer dynamic-viewport-safe sizing. Do not attempt the #63 fix here.
