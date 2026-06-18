# LLD 27: Card Selection Animation Feels Slow on Mobile

## Scope

**Covers:**
- Adding CSS custom properties for card selection transition duration and easing
- Overriding to instant (0ms) on mobile viewports (<=767px) and `prefers-reduced-motion`
- Updating `GameCard.vue` to consume the new variables instead of hardcoded transition values

**Does NOT cover:**
- Reactivity investigation in `useCardSelection.ts` (follow-up issue if needed post-merge)
- Adding `touch-action: manipulation` or `will-change` properties
- Desktop transition behavior changes (desktop keeps current 150ms ease)
- Any JavaScript-level performance optimizations

---

## Approach

### Strategy: CSS Variables for Transition Duration/Easing

The existing card selection uses a hardcoded `transition: transform 0.15s ease` in `GameCard.vue` (line 73). On mobile (Firefox Android specifically), this 150ms transition feels sluggish because the card lift doesn't appear instant to the user tapping cards.

The fix introduces two new CSS custom properties (`--card-select-duration` and `--card-select-easing`) with desktop defaults matching current behavior, then overrides them to `0ms`/`linear` inside the existing `@media (max-width: 767px)` block and a `@media (prefers-reduced-motion: reduce)` block.

**Why CSS-only, not JS:** The reported issue is animation speed, not state reactivity. The `useCardSelection.ts` composable creates a new `Set` on each toggle (line 28-34), which triggers Vue reactivity correctly. The perceived lag is the 150ms CSS transition making the lift feel delayed. Setting duration to 0ms makes any potential frame-level reactivity delay imperceptible.

**Why not reduce to a shorter duration (e.g., 50ms)?** On mobile touch interactions, users expect immediate tactile feedback. Any non-zero transition creates a perceptible "rubber band" feel. The mockup/PR direction confirms 0ms is correct for mobile.

---

## Frontend Design

**Decision: Option B -- Optimistic Instant Lift**

On mobile viewports and for users with `prefers-reduced-motion`, card selection transitions are instant (0ms duration). Desktop retains the existing 150ms ease for a polished feel with pointer devices.

**Post-merge verification required:** After shipping this CSS fix, manually verify on Firefox Android (395x804 viewport -- the reporter's device) that multi-card selection works correctly. If a "lag by one" issue persists (card N doesn't lift until card N+1 is tapped) even with instant transitions, open a follow-up issue to investigate `useCardSelection.ts` reactivity.

---

## Interfaces / Types

No new TypeScript types or interfaces. This is a CSS-only change.

---

## State Model

No state changes. The existing `selectedIndices` ref in `useCardSelection.ts` drives the `.card--selected` class binding. The CSS transition property controls how fast the visual lift appears -- this LLD only changes that timing.

| What changes | Where | Before | After |
|---|---|---|---|
| Card selection transition duration | `game-variables.css` | (not a variable) | `--card-select-duration: 150ms` (desktop), `0ms` (mobile/reduced-motion) |
| Card selection transition easing | `game-variables.css` | (not a variable) | `--card-select-easing: ease` (desktop), `linear` (mobile/reduced-motion) |
| GameCard `.card` transition | `GameCard.vue` | `transition: transform 0.15s ease, ...` | `transition: transform var(--card-select-duration) var(--card-select-easing), ...` |

---

## File Changes

### `src/frontend/styles/game-variables.css`

Add two new variables to the `:root` block:

```css
/* Card selection animation tokens */
--card-select-duration: 150ms;
--card-select-easing: ease;
```

Add overrides inside the existing `@media (max-width: 767px)` block:

```css
--card-select-duration: 0ms;
--card-select-easing: linear;
```

Add a `@media (prefers-reduced-motion: reduce)` block (if not already present, or extend the existing one from LLD 11):

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --card-select-duration: 0ms;
    --card-select-easing: linear;
  }
}
```

### `src/frontend/component/game-ui/GameCard.vue`

Replace the hardcoded transition on `.card` (line 72-75):

```css
/* Before */
transition:
  transform 0.15s ease,
  box-shadow 0.15s ease,
  border-color 0.15s ease;

/* After */
transition:
  transform var(--card-select-duration) var(--card-select-easing),
  box-shadow var(--card-select-duration) var(--card-select-easing),
  border-color var(--card-select-duration) var(--card-select-easing);
```

---

## Edge Cases

1. **Desktop unchanged:** The `:root` defaults (`150ms ease`) match the current hardcoded values exactly. No visual regression on desktop.

2. **prefers-reduced-motion on desktop:** Users who enable reduced motion at the OS level get instant transitions even on desktop. This is correct accessibility behavior.

3. **Mobile landscape (>767px width):** Reverts to desktop timing (150ms). Acceptable since landscape phones have mouse-like precision and the desktop timing feels fine at larger widths.

4. **CSS variable fallback:** If a browser doesn't support CSS custom properties (extremely unlikely -- baseline since 2017), the transition shorthand becomes invalid and the browser discards it, resulting in no transition (instant). This is the desired mobile behavior anyway.

5. **box-shadow and border-color timing:** These are coupled to the same duration/easing as transform. On mobile (0ms), the gold glow and border appear instantly with the lift. On desktop, they animate together smoothly.

6. **"Lag by one" reactivity concern:** If after merge, testers observe that card N doesn't visually lift until card N+1 is tapped on Firefox Android, the root cause is in `useCardSelection.ts` (Vue reactivity scheduling), not CSS. The 0ms transition makes this imperceptible in practice, but it should be verified and a follow-up opened if observed.

---

## Dependencies

- **LLD 11: Mobile Layout** -- established the `@media (max-width: 767px)` variable override pattern in `game-variables.css` and the variable-driven approach in `GameCard.vue`
- **No backend changes**
- **No new dependencies**

---

## Test Requirements

### Visual Verification (Manual)

- [ ] Firefox Android (395x804) -- card selection lift is instant, no perceptible delay
- [ ] Chrome Android -- same instant lift behavior
- [ ] Safari iOS -- same instant lift behavior
- [ ] Desktop Chrome/Firefox (>767px) -- card selection retains smooth 150ms ease animation
- [ ] Desktop with `prefers-reduced-motion: reduce` -- card selection is instant
- [ ] Multi-card selection on mobile -- tap 3-4 cards rapidly, all lift immediately without "lag by one"
- [ ] Deselect card on mobile -- card drops back instantly

### Automated (Unit/Integration)

None required. This is a CSS variable change with no logic. The existing build (`npm run build:frontend`) validates that the CSS parses correctly. No runtime behavior changes that can be meaningfully unit-tested.

---

## Implementation Order

1. Add `--card-select-duration` and `--card-select-easing` to `:root` in `game-variables.css`
2. Add mobile overrides in the existing `@media (max-width: 767px)` block
3. Add `prefers-reduced-motion` overrides
4. Update `GameCard.vue` `.card` transition to consume the variables
5. Verify build passes (`npm run build:frontend`)
6. Manual test on mobile viewport in dev tools
7. Manual test on real Firefox Android device (reporter's environment)
