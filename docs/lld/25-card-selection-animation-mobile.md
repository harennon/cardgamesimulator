# LLD 25: Card Selection Animation Feels Slow on Mobile

## Scope

**Covers:** Fixing the perceived lag when tapping a card to select/deselect it on mobile devices. The card lift animation (`translateY`) currently uses `150ms ease` which feels unresponsive on the smaller 14px mobile lift distance.

**Does NOT cover:** Desktop animation timing (unchanged), card deal/play animations, drag gestures, or any component logic changes.

## Approach

**Decision: Optimistic Instant Lift**

Remove the transition entirely for the card selection lift on mobile. The card snaps to its selected position (up) or deselected position (down) with zero delay. On a 14px translate, any transition duration is perceptible as lag rather than as a smooth animation -- the distance is too small for the human eye to appreciate easing.

Desktop retains its existing `150ms ease` transition where the 20px lift distance makes the animation appreciable.

**Rationale:**
- The `ease` cubic-bezier starts at near-zero velocity -- on a 14px lift, the first ~50ms shows almost no visible movement, making the tap feel broken.
- Even `ease-out` at 80ms still introduces measurable input latency on touch devices where users expect instant tactile feedback.
- Card selection is a high-frequency interaction (users tap 1-5 cards per turn). Any per-tap delay accumulates into frustration.
- Mobile touch input already has inherent ~50-100ms system-level delay; adding CSS transition on top makes it worse.

**Implementation strategy:** CSS-only change via custom properties. No component logic, no props, no JavaScript changes.

## Frontend Design

**Option B -- Optimistic Instant Lift**

On mobile (viewport <= 767px), the card selection transition is removed entirely. The `translateY` applies instantly on state change, giving the user immediate visual confirmation that their tap registered. The gold border and box-shadow also apply instantly.

On desktop, the existing `150ms ease` animation is preserved -- the mouse hover already provides pre-feedback, and the 20px lift distance makes the animation smooth rather than jarring.

A `prefers-reduced-motion: reduce` media query ensures accessibility compliance by disabling transitions at all viewport sizes for users who have requested reduced motion.

## Interfaces / Types

No TypeScript interface changes. This is a pure CSS fix.

## State Model

No state model changes. The `selected` class is toggled by `useCardSelection.toggleCard()` exactly as before -- the only change is how CSS renders that class.

## Changes

### `src/frontend/styles/game-variables.css`

Add two new custom properties to `:root`:

```css
--card-select-duration: 0.15s;
--card-select-easing: ease;
```

Override in the existing `@media (max-width: 767px)` block:

```css
--card-select-duration: 0ms;
--card-select-easing: linear;
```

Add a new media query block:

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --card-select-duration: 0ms;
    --card-select-easing: linear;
  }
}
```

### `src/frontend/component/game-ui/GameCard.vue`

Replace the hardcoded transition in `.card`:

```css
/* Before */
transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;

/* After */
transition:
  transform var(--card-select-duration) var(--card-select-easing),
  box-shadow var(--card-select-duration) var(--card-select-easing),
  border-color var(--card-select-duration) var(--card-select-easing);
```

No other file changes required.

## Edge Cases

1. **`prefers-reduced-motion: reduce` enabled** -- Transition disabled at all viewport sizes. Card snaps instantly regardless of screen size.
2. **Desktop narrow window (< 768px)** -- Gets mobile treatment (instant). This is correct since the mobile CSS variables also control card size at this breakpoint, so the small card + instant lift is consistent.
3. **Orientation change while cards are selected** -- No issue. CSS variables resolve at paint time; selected cards remain in their lifted position.
4. **Rapid tap toggling** -- Instant transition means no animation queue or mid-transition state. Each tap immediately resolves to the final position.
5. **Firefox Android (reported browser)** -- `transition: 0ms` is universally supported. No vendor prefix needed.

## Dependencies

- None. This LLD modifies only existing CSS in files that already exist.
- No dependency on other LLDs.

## Test Requirements

**Unit tests:** None required. This is a visual CSS change with no logic.

**Integration tests:** None required. No state or behavior changes.

**Manual verification:**
| Scenario | Expected |
|----------|----------|
| Tap card on mobile viewport (< 768px) | Card lifts instantly, no perceptible delay |
| Tap selected card on mobile | Card drops back instantly |
| Tap card on desktop viewport (>= 768px) | Card lifts with smooth 150ms animation (unchanged) |
| Enable reduced motion in OS settings, tap card on desktop | Card lifts instantly |
| Rapidly tap same card 5x on mobile | Each toggle is immediate, no stacking/jank |
| Firefox Android 395x804 (original reporter's device) | Instant lift, no perceived lag |
