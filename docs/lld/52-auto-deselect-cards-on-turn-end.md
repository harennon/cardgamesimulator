# LLD 52: Selected cards stay raised after pressing pass; should auto-deselect

## Scope

**Covers:** Clearing the player's card selection when they press **Pass**, so any raised (`.card--selected`) cards return to the resting position in the hand immediately, mirroring the existing play-flow behavior.

**Does NOT cover:**

- Any change to pass or play server behavior. Pass already ignores the client selection; the selection has zero functional effect on the action sent to the server.
- The existing deselect-on-successful-play behavior in `onPlay()` (already correct — this LLD only brings `onPass()` in line with it).
- Turn-gated card lifting (raising/lowering cards based on `isMyTurn`). See **Frontend Design** for why this is explicitly out of scope.
- Any change to `useCardSelection`, `PlayerHand.vue`, `GameCard.vue`, or `GameBoard.vue`. The fix is confined to `GameView.vue`.

## Approach

This is a confirmed one-line fix in `src/frontend/component/game/GameView.vue`.

`onPlay()` already clears the selection after a successful play:

```ts
async function onPlay(): Promise<void> {
  const result = await playCards(props.gameId, selectedCards.value);
  if (result.success) {
    clearSelection();
  }
}
```

`onPass()` omits the equivalent call:

```ts
async function onPass(): Promise<void> {
  await pass(props.gameId);
}
```

**Decision:** Add `clearSelection()` to `onPass()` after `await pass(...)`.

**Why unconditional (no `result.success` guard like `onPlay`):** A successful play removes the played cards from the hand, so clearing selection only makes sense on success — otherwise the selection should remain so the user can retry. Passing is different: the selection has no bearing on whether the pass succeeds, and a stray selection that survives a pass is precisely the bug. The selection should be cleared regardless of the pass outcome so the cards drop back down. Therefore call `clearSelection()` unconditionally after the `pass()` call returns.

`clearSelection()` (from `useCardSelection`) resets `selectedIndices` to an empty `Set`. Because `PlayerHand.vue` binds `:selected="selectedIndices.has(index)"` and `GameCard.vue` applies the `.card--selected` raised transform purely off that `selected` prop, emptying the set immediately drops every card to its resting position — no turn check involved.

## Interfaces / Types

No interface or type changes. The fix uses the already-destructured `clearSelection` from `useCardSelection(hand)` (GameView.vue line 127–133):

```ts
const { selectedIndices, selectedCards, selectionCount, toggleCard, clearSelection } =
  useCardSelection(hand);
```

`clearSelection(): void` is already defined in `src/frontend/composables/useCardSelection.ts`.

Target change in `GameView.vue`:

```ts
async function onPass(): Promise<void> {
  await pass(props.gameId);
  clearSelection();
}
```

## State Model

- **Selection state** (`selectedIndices`) is purely client-side, in-memory, owned by the `useCardSelection` composable instance in `GameView.vue`. Nothing about it is persisted or sent over the wire on a pass.
- **Server-authoritative game state** is unaffected: `pass()` does not read `selectedCards`. There is no payload change, no new event, and no risk to game correctness or to information hiding.
- After the fix, the post-pass client state is: `selectedIndices` = empty `Set`, so `selectionCount` = 0 and no card carries `.card--selected`. This matches the post-successful-play state.

## Frontend Design

The original issue's technical hypothesis and the reviewer's approval note diverge on the visual mechanism. This section records the resolved understanding so the implementer does not chase the wrong behavior.

- **Reviewer's note (incorrect on mechanism, correct on the ask):** suggested cards visually lower when it is not your turn and re-raise on your next turn, and asked to "deselect when it's not my turn."
- **Verified mechanism (source of truth):** In `GameCard.vue`, `.card--selected { transform: translateY(var(--card-selected-lift)); }` is applied whenever the `selected` prop is true. `PlayerHand.vue` sets `:selected="selectedIndices.has(index)"`, which is **independent of `interactive`** (`interactive` is bound to `isMyTurn` in `GameBoard.vue` line 40 and only gates click/hover and the deselect path). The lift is therefore driven solely by `selectedIndices`, not by whose turn it is.

  Consequence: selected cards stay raised continuously after a pass — they do **not** auto-lower during the opponent's turn and re-raise later. The user-observed "stuck raised" state is the steady state, exactly as the bug report describes.

- **Resulting design decision:** Do **not** implement turn-gated lifting (lowering cards when `!isMyTurn`). That would be a larger, unnecessary change and contradicts the verified CSS. The correct and sufficient fix is to clear the selection when the player passes, dropping the cards immediately.

- **No re-mockup required.** This is a behavioral correction to an existing, already-approved hand/card visual (lift transform is unchanged). An approved mockup and the `lld-50` branch already cover the hand visuals; build on those. No new visual states, colors, layouts, or animations are introduced — cards simply transition from raised to resting via the existing `transform` on the `.card--selected` class toggling off.

- **Responsive scope:** The `.card--selected` transform is shared across desktop and mobile (the `@media (max-width: 767px)` block in `PlayerHand.vue` only changes padding/scroll, not the lift). Clearing selection therefore lowers cards correctly on both. Manual verification still required on desktop and mobile since the behavior is purely visual (see Test Requirements).

## Edge Cases

1. **No cards selected when Pass is pressed** — `clearSelection()` resets an already-empty `Set`; no-op, no error. (Satisfies AC: "Selection clears regardless of any pre-existing selection size.")
2. **One or many cards selected** — all indices cleared in a single assignment; all raised cards drop together. No partial state.
3. **Pass rejected by the server** (e.g., not actually the player's turn, or pass not in `validActions`) — selection is still cleared, because clearing is unconditional and the selection has no functional role in the pass. The user simply loses a stray selection; acceptable and consistent with the "drop the cards" intent. (The Pass button is already gated on `isMyTurn`/valid actions upstream, so this path is rare.)
4. **Rapid double-press of Pass** — `onPass` is `async`; `clearSelection()` runs after each `await pass(...)` resolves. Idempotent — second clear is a no-op on an empty set.
5. **Hand changes between selection and pass** (e.g., a `game:state` update reorders/shrinks the hand) — out of scope here and unchanged by this fix; `clearSelection()` empties the set regardless of current hand contents, so no stale indices remain.

## Dependencies

- `useCardSelection` composable (`src/frontend/composables/useCardSelection.ts`) — already provides `clearSelection()`. No change.
- `useGameActions().pass` (`src/frontend/composables/useGameActions.ts`) — already used by `onPass()`. No change.
- `PlayerHand.vue` / `GameCard.vue` `selected` → `.card--selected` wiring — already in place (verified). No change.
- Branch `lld-50` and the approved hand mockup — build on the existing visuals, do not re-mockup.

No new dependencies. No upstream LLD must be implemented first.

## Test Requirements

Per `docs/testing-principles.md` decision heuristic 6, prefer automated assertions over manual steps; manual is reserved for purely visual confirmation.

**Unit (component) — `GameView.vue` `onPass` behavior:**

- After `onPass()` resolves with one or more indices selected, `selectionCount` (or `selectedIndices.size`) is `0`. Assert against the composable state or via the `:selected-indices` prop passed to `GameBoard`.
- After `onPass()` resolves with no cards selected, selection remains empty and no error is thrown (idempotency).
- `pass(props.gameId)` is still called exactly once per `onPass()` invocation, with the same arguments as before (no regression to the action call).
- Selection is cleared even when the mocked `pass()` resolves as a failure/rejection (confirms the unconditional clear, distinguishing it from `onPlay`'s success-gated clear).

**Regression — `onPlay` unchanged:**

- `onPlay()` still clears selection only on `result.success === true`, and does not clear on failure. Guards against accidentally making `onPlay` unconditional while editing the adjacent function.

**Manual (visual only — cannot be asserted on computed state):**

- Desktop: select 1, then several cards; press Pass; confirm all cards animate down to the resting row immediately. Repeat with zero cards selected (Pass works, nothing jumps).
- Mobile (≤767px): same flow; confirm cards lower correctly within the horizontally scrollable hand and no card remains raised after the turn passes.
