# LLD 36: Card Selection Animation Feels Slow on Mobile

## Scope

**Covers:**
- Wrapping the reactive state update in `useCardSelection.toggleCard()` inside `requestAnimationFrame()` to synchronize with the compositor
- Adding `will-change: transform` to `.card--interactive` in `GameCard.vue` for GPU layer promotion
- Conditional forced reflow (`void el.offsetHeight`) only if rAF + will-change proves insufficient on Samsung Firefox

**Does NOT cover:**
- Changing the 0ms transition duration on mobile (LLD 27 handled this correctly)
- Using `margin-top` for card lift (does not transition properly)
- Desktop animation timing changes
- Any backend or game logic changes

---

## Approach

### Problem

LLD 27 set `--card-select-duration: 0ms` on mobile, eliminating the CSS transition delay. However, users on Firefox Android still perceive a lag between tapping a card and seeing it lift. The root cause is that Vue's reactivity scheduler batches the `selectedIndices` update and flushes it on the next microtask -- which may not align with the browser's compositor frame boundary. The card's `.card--selected` class gets applied, but the paint happens on a subsequent frame, creating a 1-frame (16ms) visual gap between the tap and the lift.

### Fix Strategy: rAF + will-change + forced reflow (if needed)

1. **`requestAnimationFrame` in `toggleCard()`** -- Wrapping the `selectedIndices.value = next` assignment inside `requestAnimationFrame()` ensures the reactive update (and subsequent DOM class change) lands on a compositor-committed frame rather than an arbitrary microtask boundary.

2. **`will-change: transform` on `.card--interactive`** -- Forces the browser to promote interactive cards to their own GPU compositor layer. This means the `translateY` change can be composited without a main-thread layout/paint, eliminating jank on lower-end mobile GPUs.

3. **Forced reflow (fallback only)** -- On Samsung Internet / Firefox Android, if rAF + will-change alone doesn't resolve the issue, reading `void el.offsetHeight` after the Set assignment forces the browser to synchronously compute layout before the next paint. This is a last resort -- try without it first.

### Why not just rAF alone?

Without `will-change`, the browser may still need a full layout + paint cycle for the transform change. With layer promotion already in place, the compositor can apply the transform change in the same frame rAF fires.

---

## Frontend Design

**Decision: Fix A -- rAF + will-change + forced reflow**

Implementation details:

1. In `useCardSelection.toggleCard()`, wrap `selectedIndices.value = next` inside `requestAnimationFrame()` so the reactive update lands on a compositor-committed frame.

2. Add `will-change: transform` to `.card--interactive` in `GameCard.vue` to force GPU layer promotion on interactive cards.

3. After assigning the new Set, read `void el.offsetHeight` (or equivalent forced reflow) if rAF alone does not fix it on Samsung Firefox -- try rAF + will-change first and only add the forced reflow if manual testing shows it is needed.

4. Do NOT change the 0ms transition duration on mobile -- that part of LLD 27 / PR #35 is correct.

5. Do NOT use `margin-top` -- it does not transition properly.

---

## Interfaces / Types

No new types. The `UseCardSelectionReturn` interface is unchanged. The only signature change is internal to `toggleCard()`.

### Modified function: `toggleCard` in `useCardSelection.ts`

```typescript
function toggleCard(index: number): void {
  const next = new Set(selectedIndices.value);
  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  requestAnimationFrame(() => {
    selectedIndices.value = next;
  });
}
```

### Modified CSS: `.card--interactive` in `GameCard.vue`

```css
.card--interactive {
  cursor: pointer;
  will-change: transform;
}
```

---

## State Model

No changes to the state model. `selectedIndices` remains a `Ref<Set<number>>`. The only behavioral difference is that the assignment is deferred by one rAF call (~0-16ms) to align with the compositor frame.

| Aspect | Before | After |
|--------|--------|-------|
| `toggleCard` timing | Synchronous (microtask) | Deferred to next animation frame |
| Layer promotion | None (browser decides) | Forced via `will-change: transform` on interactive cards |
| Reactivity trigger | Immediate on call | Within rAF callback |

**Note:** Because the assignment is now async (one frame), rapid double-taps within the same frame could theoretically race. However, since each `toggleCard` call creates its own `next` Set from the current `selectedIndices.value` at call time, and rAF callbacks execute in order, this is safe -- the second rAF sees the already-updated value from the first.

**Correction on race condition:** Actually, because the second `toggleCard` reads `selectedIndices.value` before the first rAF has fired, both closures read the same stale value. The second rAF would overwrite the first. This must be addressed -- see Edge Cases #1.

### Revised `toggleCard` with pending state

```typescript
let pending: Set<number> | null = null;

function toggleCard(index: number): void {
  const base = pending ?? selectedIndices.value;
  const next = new Set(base);
  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  pending = next;
  requestAnimationFrame(() => {
    selectedIndices.value = pending!;
    pending = null;
  });
}
```

This ensures rapid taps within the same frame accumulate correctly into a single batched update.

---

## Edge Cases

1. **Rapid multi-tap within one frame:** Two taps land before the first rAF fires. The `pending` variable accumulates both toggles, and only one rAF callback writes the final combined state. No lost taps.

2. **`clearSelection()` called while rAF pending:** `clearSelection()` writes synchronously (`selectedIndices.value = new Set()`). If a pending rAF then fires, it would overwrite the clear. Fix: `clearSelection()` must also set `pending = null`.

   ```typescript
   function clearSelection(): void {
     pending = null;
     selectedIndices.value = new Set();
   }
   ```

3. **Component unmount with pending rAF:** The rAF fires after unmount but the ref is still valid (not garbage collected). The write is harmless -- it updates a detached reactive ref. No cleanup needed.

4. **Desktop (150ms transition):** `will-change: transform` is applied to `.card--interactive` regardless of viewport. On desktop this is fine -- GPU promotion for interactive elements is a net positive. The rAF wrapper also applies universally but has no perceptible effect on desktop since the 150ms CSS transition already masks any single-frame delay.

5. **`prefers-reduced-motion`:** No impact. The 0ms duration is a CSS concern (already handled by LLD 27 variables). The rAF fix ensures the class is applied on the right frame regardless of transition duration.

6. **Samsung Firefox forced reflow:** If testing on Samsung Firefox shows the issue persists after rAF + will-change, add a forced reflow inside the rAF callback before the assignment. This is NOT in the initial implementation -- only add it based on manual test results.

---

## Dependencies

- **LLD 27: Card Selection Animation** -- already implemented. Provides the CSS variables and 0ms mobile duration this LLD builds on.
- **No backend changes.**
- **No new npm dependencies.**

---

## Test Requirements

### Unit Tests (Vitest)

Existing `tests/frontend/useCardSelection.test.ts` tests pass without modification since they test the logical correctness of selection (which indices are selected), not timing. However, add:

1. **Rapid toggle batching:** Call `toggleCard(0)` then `toggleCard(1)` synchronously. After advancing one animation frame (using `vi.useFakeTimers()` + `vi.advanceTimersByTime(16)` or mocking `requestAnimationFrame`), assert both indices are selected.

2. **clearSelection cancels pending:** Call `toggleCard(0)`, then immediately `clearSelection()`. After rAF fires, assert `selectedIndices` is empty (not `{0}`).

3. **Toggle-then-untoggle in same frame:** Call `toggleCard(0)` then `toggleCard(0)`. After rAF fires, assert index 0 is NOT selected (the second toggle undoes the first).

### Visual Verification (Manual)

| Device/Browser | Check |
|---|---|
| Firefox Android 395x804 (reporter's device) | Card lifts on same frame as tap -- no perceptible delay |
| Chrome Android | Same instant-lift behavior |
| Safari iOS | Same instant-lift behavior |
| Desktop Chrome (>767px) | 150ms ease transition still smooth, no regression |
| Desktop with `prefers-reduced-motion` | Instant lift, no regression |
| Rapid 4-card selection on mobile | All cards lift without any lost taps |

### Build Verification

- `npm run build:frontend` passes (no TypeScript errors from rAF usage)
- `npm run lint:fix` passes
- Existing `useCardSelection.test.ts` tests still pass (mock rAF or use `vi.runAllTimers()`)

---

## Implementation Order

1. Modify `useCardSelection.ts`: add `pending` variable, wrap assignment in `requestAnimationFrame`, update `clearSelection` to nullify pending
2. Add `will-change: transform` to `.card--interactive` in `GameCard.vue`
3. Update existing unit tests to account for async rAF (mock `requestAnimationFrame` globally in test setup)
4. Add new unit tests for batching and clear-cancels-pending
5. Run `npm run build:frontend` and `npm test`
6. Manual test on Firefox Android -- if lift is still delayed, add forced reflow inside rAF callback
7. Manual test full matrix from table above
