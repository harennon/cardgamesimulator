# LLD 152: Add card animations for dealing and playing cards

## Scope

Presentation-only motion for two moments in the core gameplay loop, on both the
Big2 (`GameBoard.vue`) and Tonk (`TonkBoard.vue`) boards:

1. **Deal-in** — at round start, the **local player's own hand** cards animate in
   with a brief staggered slide-up (mockup variant **A**).
2. **Play-to-center** — when a play lands in the play area, the played-cards row
   animates in with a brief drop (mockup variant **1**).

**Explicitly NOT in scope:**

- Any change to game logic, engine, server-authoritative state, `validActions`,
  or WebSocket payloads. This is CSS + a small amount of view-layer trigger
  wiring only.
- Animating opponent card-backs, opponent counts, the game log, the trick pile,
  the turn timer, or the Tonk stock/drawable slots. Only the two moments above.
- Card **selection / hover** motion in `GameCard.vue` (lines 92–95). Those
  transitions already exist and must be left untouched.
- New animation libraries. Reuse the established approach: CSS `@keyframes` (as
  in `TurnTimer.vue` / `GameOverView.vue`) and Vue's built-in `TransitionGroup`.
- Card-back deal-in for opponents, and any "fly from a deck anchor" motion
  (mockup variant B was explicitly rejected as ill-fitting for Tonk's
  stock/discard sources).

The design has an approved frontend-architect mockup at
`card-deal-play-animations.html` (owner selected **A + 1**). This LLD confirms
against that mockup rather than re-designing.

## Approach

### Key decisions

1. **Pure CSS keyframes, GPU-composited.** Both animations use only `transform`
   and `opacity` (no layout-affecting properties), matching the mockup and the
   existing `TurnTimer` glow. This guarantees no reflow, no layout shift, and no
   scroll jank in the horizontally-scrollable hand.

2. **Trigger via a CSS class toggled by the view, not by remounting.** The
   animations must fire on the *right* events only:
   - **Deal-in** fires when a fresh full hand appears (round start), and must NOT
     re-fire on every hand mutation (e.g. after the local player plays a card and
     the hand shrinks). We gate it behind an explicit `dealing` boolean the board
     sets true for the animation window, then clears.
   - **Play-to-center** fires when `lastPlay` (Big2) / `discardTop` (Tonk)
     changes to a *new* play, keyed so the row re-enters on each new play.

3. **Do not block input.** Animations are `animation-fill-mode: both` /
   `forwards` but the elements are fully interactive throughout — no `pointer-events`
   gating, no disabling of the action panel, no `setTimeout` on the game loop.
   The `validActions`-driven `interactive` prop already governs clickability and
   is unchanged. Card selection (tap/click) works during and after the deal-in.

4. **Reduced motion gates ALL card motion.** A single
   `@media (prefers-reduced-motion: reduce)` block sets `animation: none` on both
   the deal-in and play-in selectors, so reduced-motion users get today's instant
   render byte-for-byte. This mirrors `TurnTimer.vue` lines 170–178 and the
   `game-variables.css` reduced-motion block.

5. **Detection logic lives in a testable composable, not inline in the SFC.**
   Because the test environment is `environment: node` (no DOM mount — see
   `vitest.config.ts`), and the established pattern (`tonkTrickReveal.test.ts`,
   `TurnTimer.test.ts`) extracts load-bearing logic into pure functions /
   composables and tests those, the "when should deal-in fire" and "has the play
   changed" logic is extracted into a composable `useCardAnimations` with pure
   helpers. The `.vue` files consume it and apply classes; the untestable part
   (the actual CSS motion) is verified manually.

### Why "A + 1"

Per the mockup's recommendation and owner selection:

- **Deal A (slide-up)** reads clearly on mobile with no horizontal-overflow risk
  (cards translate on the Y axis only, inside the existing overflow-x container).
- **Play 1 (drop)** is the most legible "a play just landed" cue and implies no
  specific source position, so it works identically for Big2's play area and
  Tonk's discard top.

### Where the classes are applied

| Moment          | Big2 file / element                                   | Tonk file / element                              |
| --------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Deal-in         | `PlayerHand.vue` — `.player-hand` gets `.dealing`; each `GameCard` gets `--i` index var | `TonkHand.vue` — `.tonk-hand` gets `.dealing`; each card gets `--i` |
| Play-to-center  | `PlayArea.vue` — `.play-area__card-row` gets `.landing` + a `:key` on the row | `TonkPiles.vue` — `.tonk-piles__card-wrap` (discard slot) gets `.landing` + `:key` on discard top |

## Interfaces / Types

New composable: `src/frontend/composables/useCardAnimations.ts`

```ts
// Pure helper: should the deal-in animation run for this hand snapshot?
// Fires when a fresh full hand appears (round start). Does NOT fire when the
// hand shrinks (a play/discard) or grows by draw (Tonk). Detection is by a
// "round key" that changes only at a fresh deal, not by hand length deltas.
//
// prevLen: hand length on the previous tick (0 or undefined before first deal)
// nextLen: current hand length
// Returns true only on the empty/short -> full transition characteristic of a deal.
export function isFreshDeal(prevLen: number, nextLen: number): boolean;

// Pure helper: a stable identity string for the "current play" so the play row
// re-enters (re-keys) only on a genuinely new play, not on unrelated re-renders.
// Big2:  playKey(lastPlay)  -> `${playerId}:${cards.map(rank+suit).join()}` | ""
// Tonk:  discardKey(discardTop, discardCount) -> `${discardCount}:${rank}${suit}` | ""
export function playKey(
  lastPlay: { playerId: string; cards: readonly { rank: string; suit: string }[] } | null,
): string;
export function discardKey(
  discardTop: { rank?: string; suit?: string; id?: string } | null,
  discardCount: number,
): string;
```

Board-level reactive glue (in `GameBoard.vue` / `TonkBoard.vue`), driven by the
helpers above:

```ts
// dealing: true for one animation window at round start, then auto-cleared.
const dealing = ref(false);
// playKey/discardKey bound to the play-row :key so it re-enters per new play.
```

No changes to `EnrichedPlayerView`, `Big2PublicState`, `TonkPublicState`,
`Big2Play`, `TonkCard`, or any prop contract. `GameCard.vue`'s props are
unchanged; the `--i` stagger index is passed as an inline CSS custom property on
the wrapper element, not as a Vue prop.

## State Model

All state is **transient, in-memory, per-client, view-layer only.** Nothing is
persisted, nothing is sent to the server, and no engine/game state is read or
written differently than today.

**Deal-in state machine (per board component):**

```
mount (displayPhase -> IN_PROGRESS)  ─┐
                                       ├─►  dealing = true
round start (fresh full hand)       ─┘        │  (CSS runs deal keyframes,
                                              │   staggered by --i)
                                              ▼
             animationend on last card / max-duration guard timer
                                              │
                                              ▼
                                       dealing = false  (class removed)
```

- **Big2:** one deal per game (no mid-game re-deals — confirmed: `Big2PublicState`
  has no round counter and `isFirstPlayOfGame` flips once). Deal-in fires once,
  on board mount / first full hand.
- **Tonk:** a fresh hand is dealt each deck-round while the board stays mounted.
  `isFreshDeal` re-arms `dealing` on the empty/short→full hand transition at each
  new round; ordinary discard (shrink) and draw (grow by one) do NOT re-trigger.

**Play-to-center state:**

- Purely reactive: the played-row element carries `:key="playKey(...)"`. When the
  key changes (new play landed), Vue tears down and re-creates the element, so
  the CSS `.landing` keyframe runs on the fresh element automatically. No boolean
  toggle needed; no timer needed. On the *same* play re-rendering (e.g. a window
  resize), the key is unchanged, so no re-animation.

**Cleanup:** the `dealing` clear uses `onAnimationend` on the hand container with
a fallback `setTimeout` (deal-duration + max stagger + slack) so a missed
`animationend` (e.g. tab backgrounded) can't strand the class. The timer is
cleared on unmount.

## Edge Cases

1. **Local player plays a card → hand shrinks.** Deal-in must NOT re-fire.
   `isFreshDeal` returns false for a shrink; the `dealing` flag is already false
   after the initial window. Only the played row (play-to-center) animates.

2. **Tonk draw (hand grows by one).** Not a fresh deal → no deal-in. The single
   drawn card is not individually animated (out of scope; only round-start
   deal-in and play-to-center are in scope).

3. **New Tonk deck-round (fresh full hand mid-game).** `isFreshDeal` detects the
   short/empty→full transition and re-arms deal-in for that round. Confirm the
   Tonk round-start hand replacement produces this transition; if the hand is
   swapped full→full without an intermediate empty, gate on the round/trick
   signal instead (Tonk exposes `trickNumber`) — implementer picks whichever the
   runtime state actually produces and documents it.

4. **Reduced motion.** `@media (prefers-reduced-motion: reduce)` sets
   `animation: none` on all deal-in and play-in selectors → instant render, no
   motion, no stagger. Verified as the acceptance-critical path.

5. **Spectator / no own hand (`myPlayerIndex === -1`).** No hand renders, so no
   deal-in. Play-to-center still animates (public info). Must not throw when
   `you.hand` is empty/undefined.

6. **Rapid consecutive plays (fast AI or fast opponents).** Each new play
   re-keys the row; if a new play lands mid-animation the element is replaced and
   the new keyframe starts from the top. Acceptable — the latest play is always
   the one shown. No queueing.

7. **Reconnection / state resync mid-game.** On reconnect the board re-mounts with
   the current hand already full. Deal-in firing once on that mount is acceptable
   (a brief settle), but must not fire repeatedly on subsequent state pushes. The
   `dealing`-flag window (one-shot then cleared) ensures this.

8. **Mobile horizontal-scroll hand.** Deal-in translates on Y only within the
   existing `overflow-x: auto` container; the row's scroll width is unchanged
   during animation (transforms don't affect layout), so no scroll jank and no
   layout shift. Verify the `-webkit-overflow-scrolling: touch` container is not
   disturbed.

9. **`prefers-reduced-motion` toggled at runtime.** CSS media query re-evaluates
   live; no JS listener needed. New animations respect the new setting.

10. **Large hand (13 Big2 cards) stagger total.** With `--deal-stagger: 45ms` ×
    12 + `--deal-duration: 260ms`, the last card finishes ~800ms after start.
    That exceeds the 150–300ms per-card budget only in aggregate wall-clock; each
    card's own motion is ≤260ms and input is never blocked. Acceptable and
    matches the approved mockup. Implementer may cap total stagger if it feels
    long on 13 cards, but must not exceed the mockup's tokens without owner sign-off.

## Dependencies

- **Existing components (read + lightly edit):** `PlayerHand.vue`, `PlayArea.vue`,
  `TonkHand.vue`, `TonkPiles.vue`, and their parents `GameBoard.vue` /
  `TonkBoard.vue` (to own the `dealing` ref and pass the key).
- **`GameCard.vue`:** consumed unchanged. Its selection/hover transition stays.
- **Design tokens:** add the mockup's animation tokens to
  `src/frontend/styles/game-variables.css` (`--deal-duration`, `--deal-stagger`,
  `--deal-easing`, `--play-duration`, `--play-easing`) and zero them under the
  existing `@media (prefers-reduced-motion: reduce)` block for defense-in-depth,
  in addition to the `animation: none` selectors.
- **Approved mockup:** `card-deal-play-animations.html` (variants A + 1).
- No backend, engine, migration, or shared-type dependencies. No new npm packages.

## Frontend Design

Owner-approved direction: **Deal variant A (slide-up) + Play variant 1 (drop)**,
matching the recommended default in `card-deal-play-animations.html`. Confirm the
implementation against that mockup; do not introduce new variants.

**Animation tokens** (add to `:root` in `game-variables.css`, values from mockup):

```css
--deal-duration: 260ms;
--deal-stagger: 45ms;
--deal-easing: cubic-bezier(0.22, 1, 0.36, 1); /* easeOutQuint-ish */
--play-duration: 240ms;
--play-easing: cubic-bezier(0.22, 1, 0.36, 1);
```

**Deal-in (variant A) — applied in `PlayerHand.vue` and `TonkHand.vue`:**

```css
.player-hand.dealing .player-hand__card {
  animation: dealSlide var(--deal-duration) var(--deal-easing) both;
  animation-delay: calc(var(--i) * var(--deal-stagger));
}
@keyframes dealSlide {
  from { opacity: 0; transform: translateY(46px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

- Each card element receives `style="--i: {{ index }}"` for the stagger.
- The `.dealing` class is bound to the parent-owned `dealing` ref.
- The card `transform-origin` should be `bottom center` so slide-up settles at
  the resting position (matches the mockup's hand). The existing selection
  `translateY` on `.card--selected` composes fine because deal-in has cleared
  (`dealing=false`) before a user could select.

**Play-to-center (variant 1) — applied in `PlayArea.vue` and Tonk discard slot:**

```css
.play-area__card-row.landing {
  animation: playDrop var(--play-duration) var(--play-easing) both;
}
@keyframes playDrop {
  from { opacity: 0; transform: translateY(-28px) scale(1.14); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
```

- The whole row animates as one unit (variant 1, not the per-card stagger of
  variant 3). It re-enters via `:key` change on new play (see State Model), so
  the `.landing` class can be static on the row and still animate per play.

**Reduced-motion (acceptance-critical) — one block per SFC, mirroring `TurnTimer.vue`:**

```css
@media (prefers-reduced-motion: reduce) {
  .player-hand.dealing .player-hand__card,
  .play-area__card-row.landing { animation: none; }
}
```

(Equivalent blocks in `TonkHand.vue` / `TonkPiles.vue`.)

**What stays untouched:** `GameCard.vue` selection/hover transition; opponent
row; trick pile; turn timer; game log; Tonk stock/drawable slots; the log drawer
transition.

## Test Requirements

Per `docs/testing-principles.md` §heuristic-6, animation *visuals* cannot be
asserted in `environment: node` and are verified manually; the *decision logic*
is extracted and unit-tested. Bias toward automated tests for the logic, a small
manual table for the motion.

### Unit (Vitest, node env — pure helpers in `useCardAnimations`)

- `isFreshDeal`:
  - true on empty→full (0 → 13) — round start.
  - false on full→shrunk (13 → 12) — a play/discard (E1).
  - false on grow-by-one (10 → 11) — a Tonk draw (E2).
  - false on full→full identical length (no re-arm on unrelated re-render).
- `playKey`:
  - returns "" for `null` lastPlay (free trick / no play).
  - returns a stable string for the same play across calls (idempotent — E6).
  - returns a *different* string for a different play (new cards or new player).
- `discardKey`:
  - returns "" for null discard top.
  - changes when `discardCount` increments (new discard landed) even if the top
    card's rank/suit repeats.
- Reduced-motion is a CSS concern (no JS branch); assert only that no helper
  gates behavior on motion preference (helpers are motion-agnostic).

### Integration

- None required. No engine, server, or socket behavior changes; existing Big2 /
  Tonk full-game and view tests must continue to pass unchanged (regression gate:
  deal/play trigger wiring must not alter emitted actions or `validActions`
  handling).

### Manual (motion + responsiveness — cannot be automated in node env)

| # | Scenario | Expected |
|---|----------|----------|
| M1 | Big2: start a game | Own 13-card hand slides up, staggered; finishes < ~1s; input available throughout |
| M2 | Big2: play a pair | Played row drops into center (~240ms); hand does NOT re-deal |
| M3 | Tonk: start a round | Own hand slides up (staggered); on a new deck-round it re-arms |
| M4 | Tonk: discard a card | Discard top drops in; hand does not re-deal; draw does not deal-in |
| M5 | Enable OS reduced-motion, repeat M1–M4 | No card motion anywhere; instant render identical to today |
| M6 | Mobile viewport (≤767px), M1–M2 on both boards | No layout shift, no horizontal scroll jump/jank in the hand |
| M7 | Rapid opponent/AI plays | Latest play always shown; no stuck/overlapping animation |
| M8 | Spectator (no own hand) | No error; play-to-center still animates |

### Security

- N/A. No data exposure surface changes; no new payload fields; hidden
  information handling is untouched (presentation-only).
