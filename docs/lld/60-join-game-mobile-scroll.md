# LLD 60: Join-game Screen Requires Excessive Scrolling on Mobile

## Scope

Fixes the `/join-game` screen (and every other screen sharing `.flow-page`) being
forced taller than the viewport on mobile, which causes vertical scrolling on a
short, single-glance form.

**Covers:**

- `.app-shell` in `src/frontend/component/App.vue` (the outer flex-column shell).
- `.flow-page` in `src/frontend/styles/flows.css` (the per-flow page wrapper).

**Does NOT cover:**

- Any markup, component, content, or behavior changes. This is a pure CSS layout
  fix.
- The in-game route (`/game/:id`), which hides the nav (`showNav`) and does not use
  `.flow-page`.
- The mobile breakpoint content tweaks already present in `flows.css`
  (`align-items: flex-start; padding-top: 48px`) — those stay as-is.

## Approach

**Root cause.** Two full-viewport-height containers are stacked:

- `.app-shell` is `min-height: 100vh` and is a flex column holding the nav bar,
  `<router-view>`, and `FeedbackWidget`.
- `.flow-page` (the routed page) is **also** `min-height: 100vh`.

Because `.flow-page` renders below the ~48px nav bar yet is itself forced to a full
`100vh`, document height becomes `nav height + 100vh`, always exceeding the viewport
by roughly the nav's height. On mobile this is worse: CSS `100vh` includes the area
behind the browser URL/toolbar chrome (mobile `100vh` > visible viewport), so even a
short form overflows the visible area and scrolls. Scroll amount scales with device
chrome size, matching the "scrolls a lot" report.

**Decision — Option A (flex-fill), approved and locked.** Let `.flow-page` consume
exactly the space left after the nav inside the already-flex `.app-shell`, instead of
declaring a second hard viewport height:

- `.flow-page` becomes a flex child: `flex: 1; min-height: 0`. It fills the remaining
  column space below the nav — no viewport-height math, no double counting.
- `.app-shell` switches from `min-height: 100vh` to `min-height: 100dvh`
  (dynamic viewport height) so the shell tracks the *visible* viewport on mobile as
  browser chrome shows/hides, rather than the larger `100vh` chrome-inclusive box.

This works because `.app-shell` is already `display: flex; flex-direction: column`
and `<router-view>` renders `.flow-page` as a direct child of `.app-shell`, so
`flex: 1` applies cleanly. `min-height: 0` is included so a genuinely tall form can
still grow the flex item beyond the available space (correct scroll behavior) rather
than being clamped.

**Rejected — Option B (nav-height magic number).** Sizing `.flow-page` as
`min-height: calc(100vh - <nav height>)` was rejected: the nav height is not fixed
(font scaling, wrapping, future nav changes) and a hardcoded constant silently
breaks when the nav changes. Do NOT reintroduce a nav-height constant.

**Why `dvh` and not `svh`/`lvh`.** `100dvh` resolves to the *current* visible
viewport and updates as chrome collapses/expands — the behavior we want for a form
that should fit "as seen now." `svh` (smallest) would leave a gap when chrome is
hidden; `lvh` (largest) reproduces the original overflow. `dvh` is supported in all
current evergreen mobile browsers; on the rare engine lacking it, `min-height` simply
falls back to its initial value (`auto`) and the flex layout still fills the column —
no regression, just no chrome-tracking. No `100vh` fallback declaration is needed
because `flex: 1` already does the load-bearing work; `min-height` on the shell is
only a backstop to keep the shell at least one screen tall on near-empty pages.

This change passes the architecture decision heuristics: it adds no cost, has no
security/state implications (pure presentation; server-authoritative model
untouched), and does not affect scaling.

## Interfaces / Types

None. No TypeScript, props, events, or shared model changes. CSS-only.

## State Model

No state. No persistence, no in-memory state, no reactive state involved.

## Frontend Design

Approved direction: **Option A (flex-fill)**, per the issue's
"Frontend decision: Option A" selection.

Exact CSS changes (final values the implementer must produce):

1. `src/frontend/component/App.vue`, `.app-shell`:
   - Change `min-height: 100vh;` → `min-height: 100dvh;`
   - Leave `display: flex; flex-direction: column; background: var(--bg-dark);`
     unchanged.

2. `src/frontend/styles/flows.css`, `.flow-page` (currently lines ~6–12):
   - Remove `min-height: 100vh;`
   - Add `flex: 1;` and `min-height: 0;`
   - Keep `display: flex; align-items: center; justify-content: center;
     padding: 40px 20px;` unchanged.
   - The `@media (max-width: 767px)` block for `.flow-page`
     (`align-items: flex-start; padding-top: 48px; padding: 24px 16px;`) stays
     exactly as-is. Top-anchoring on mobile is correct and complements this fix.

Resulting layout behavior:

- **Desktop:** `.flow-page` fills the column below the nav; `align-items: center` +
  `justify-content: center` keep the `.form-card` vertically and horizontally
  centered in that space (centering preserved — required by acceptance criteria).
- **Mobile, short form:** `.flow-page` is exactly viewport-minus-nav tall
  (via `flex: 1` inside a `100dvh` shell), content anchored to top with
  `padding-top: 48px`; the page fits without scrolling.
- **Mobile, tall form (e.g. keyboard open, or a long form):** `min-height: 0` lets the
  flex item exceed available height; the page scrolls — which is the correct behavior.

No HTML mockups are required: there is no visual redesign, no new/changed markup, and
no new component. The visual result is "the same forms, just no longer over-tall."
This is the documented exception to the mockup-first rule (pure CSS sizing fix, zero
layout/content change), so the design can be specified directly here.

## Edge Cases

1. **Tall form / on-screen keyboard open on mobile** — Page must still scroll.
   Handled: `min-height: 0` on the flex item permits overflow; the shell does not clip.
2. **Browser without `dvh` support** — `min-height: 100dvh` is ignored; `min-height`
   falls back to `auto`. `flex: 1` still fills the column, so no overflow regression;
   the only loss is chrome-height tracking (acceptable, rare).
3. **Other `.flow-page` consumers** — `login`, `signup`, `create-game`, `home`
   (`HomeView`), and `guest-entry` (`GuestEntryView`) all use `.flow-page` and none
   override its height. They inherit the same fix and must be verified for no
   regression on mobile and desktop.
4. **In-game route** — `showNav` is false on `/game/:id` and that route does not use
   `.flow-page`; unaffected. (Sanity-check it still renders full height since the nav
   is absent and the shell is now `100dvh`.)
5. **Very large desktop viewport** — `.form-card` has `max-width` and intrinsic
   height; centered in a full-height `.flow-page`. No change from today.

## Dependencies

None. No upstream LLD or code must change first. The fix touches only existing CSS in
`App.vue` and `flows.css`. Related prior work for context only:
LLD 32 (mobile responsiveness, non-game screens) introduced the `flows.css` mobile
breakpoint; this LLD does not alter that block.

## Test Requirements

Per testing-principles §10 ("Don't test framework behavior") and the bias against
manual tests, automated coverage for a pure CSS-sizing fix is low-value (it would test
browser layout, not our logic). Verification is primarily manual/visual, which is the
sanctioned exception for "layout/responsiveness."

**Manual (required) — real mobile viewport ~390×844 with browser chrome:**

1. `/join-game` (short form): loads with **no vertical scroll**; form anchored near
   top. (Primary acceptance criterion.)
2. `/login`, `/signup`, `/create-game`, `/` (home), guest-entry view: each fits
   without scroll on mobile when short; no visual regression versus current build.
3. Tall case: focus the input so the on-screen keyboard appears; confirm the page can
   still scroll to reach the submit button (overflow is permitted, not clipped).

**Manual (required) — desktop (e.g. 1280×800):**

4. `.form-card` on each `.flow-page` route is vertically and horizontally centered
   (centering preserved).
5. Page height equals the viewport (no extra scroll introduced by the nav + page).

**Automated (optional, only if cheap):**

6. If an existing Playwright/E2E setup with a mobile viewport already runs these
   routes, add an assertion that `document.scrollingElement.scrollHeight <=
   window.innerHeight` (i.e. no vertical overflow) on `/join-game` with an empty form.
   Do not stand up new E2E infrastructure solely for this check.

No unit tests are warranted (no pure functions, no state transitions, no validation
logic changed).
