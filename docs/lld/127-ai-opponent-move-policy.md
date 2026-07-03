# LLD 127: Improve AI opponent move quality beyond default auto-timeout heuristic

Parent: #127 (AI opponents). Depends on #118 (AI-seat foundation, merged as #137/#138). Backend-only. No UI, no migration, no schema change.

## Scope

**Covers (backend/engine only):**

1. A dedicated **AI move-selection policy** per engine, exposed as a new pure engine method `getAiMoveAction(state)`, **separate** from `getAutoTimeoutAction`. AI seats route to the policy; abandoned/timed-out human seats keep `getAutoTimeoutAction` exactly as today.
2. **Big2 policy:** lead sensibly instead of always passing, shed low cards early, avoid gratuitously breaking up multi-card combinations, and hold very high singles (2s) rather than dumping them first.
3. **Tonk policy:** discard to minimize hand value, draw from the discard only when the drawable card lowers hand value, and call TONK when hand value is low enough to be worth it.
4. Routing the **AI-seat branch** of `autoPlayAbandoned` to `getAiMoveAction`, leaving the abandoned-human path (both in the loop and in `handleTimerExpired`) on `getAutoTimeoutAction`.

**Explicitly does NOT cover:**

- Difficulty levels / configurable AI strength. One reasonable policy per engine.
- Lookahead search, Monte Carlo, ML, or any probabilistic modeling of hidden cards.
- Any change to `getAutoTimeoutAction` behavior (abandoned/timeout seats are byte-for-byte unchanged).
- Stats/history exclusion, lobby/create-game UI, seat plumbing, or AI-seat identity — all owned by #118/#137/#138 and locked.
- Any frontend change, migration, or external/network call.

## Approach

### A. A distinct policy path, `getAiMoveAction`, not a rewrite of `getAutoTimeoutAction`

`getAutoTimeoutAction` is the *minimum-legal* move for an abandoned human (Big2: pass if legal else lowest single; Tonk: draw-stock / discard-highest). That behavior is a hard-required invariant for the timeout path and **must not change**.

Add a new method to the `GameEngine` interface (`src/backend/engine/game-engine.ts`), parallel to `getAutoTimeoutAction`:

```ts
/**
 * Determine the move an AI-controlled seat should make.
 *
 * Distinct from getAutoTimeoutAction (which is the minimal-legal move for an
 * abandoned human). This is a heuristic that plays a reasonable, human-plausible
 * game while remaining pure and deterministic.
 *
 * Contract:
 * - Returns a valid GameAction for the current player, or null when no auto-
 *   action applies (COMPLETED / not started / currentPlayerIndex < 0), matching
 *   getAutoTimeoutAction's null contract exactly.
 * - Pure: no I/O, no PRNG, no Math.random. Same (state) => same action.
 * - Information hiding: reads ONLY the current seat's own hand + public state.
 *   Must never inspect any other seat's hand. (Enforced by an internal
 *   own-hand+public helper; see §Information hiding.)
 * - The returned action is always legal: engine.validateAction(state, action)
 *   is true for the returned action.
 */
getAiMoveAction(state: InternalGameState): GameAction | null;
```

Rationale for a new method (not a flag on `getAutoTimeoutAction`, not a standalone module): the engine already owns move generation, hand shapes, comparison helpers, and validation. Keeping the policy as an engine method reuses all of that, keeps it pure, and mirrors the existing `getAutoTimeoutAction` seam that the socket layer already calls. A separate top-level "AI service" would duplicate engine-internal helpers and risk drifting from the rules.

### B. Information hiding (hard constraint + review gate)

The policy takes the full `InternalGameState` (same as every other engine method) but **must only read the current seat's own hand and public state**. To make this structurally enforceable and testable:

- Each engine's `getAiMoveAction` first resolves `seatIndex = state.currentPlayerIndex` and `myHand = hands[seatIndex]`, then delegates to a **pure inner function** whose signature accepts only own-hand + public inputs — never the full `hands` array. Big2:

  ```ts
  function chooseBig2Move(myHand: readonly Card[], pub: Big2PolicyView): Big2Action
  // Big2PolicyView = { lastPlay, isFreePlay, isFirstPlayOfGame, lowestCard, ... }
  ```

  Tonk:

  ```ts
  function chooseTonkMove(myHand: readonly TonkCard[], pub: TonkPolicyView): TonkAction
  // TonkPolicyView = { turnPhase, drawableDiscard, tonkGateOpen, stockCount, ... }
  ```

  Because the inner function is not handed the other seats' hands, it *cannot* read them. The outer method does the seat lookup and passes only own-hand + public-derived fields. This is the enforcement mechanism the acceptance criteria and review gate require: the leakage prohibition is expressed in the function signature, not merely in a comment.

- Tests assert this directly (see Test Requirements): construct a state where opponents hold cards that, if the policy could see them, would change its choice; assert the choice is identical whether or not those opponent hands are mutated. Plus the standard information-leakage pattern already used in the engine tests.

### C. Big2 policy (`chooseBig2Move`)

Design goal: clearly better than "always pass / dump lowest", still simple and deterministic. Strategy, evaluated in order:

**C1. First play of game (`isFirstPlayOfGame`).** Must include the mandated lowest card (3♣ / 3♦ per player count — reuse the engine's existing lowest-card logic). Choose the **largest legal combination that contains the lowest card and does not break a strictly better-kept group**, preferring in this order:
1. A 5-card combo (straight / flush-category) that includes the lowest card, if one exists — sheds the most cards while the low card is otherwise near-useless.
2. A pair that includes the lowest card, if the lowest card has a rank-mate.
3. Otherwise the lowest single (same as timeout for this narrow case, but only here).

This "shed low cards early" bias is the core requirement: the lowest card is played the moment it is legal, ideally bundled into a combo.

**C2. Free play / leading a trick (`isFreePlay`, must play, cannot pass).** The AI leads. Choose a combination that sheds low, cheap cards while conserving high cards and intact combos:
1. Enumerate the AI's own candidate plays from its hand (singles, pairs, and 5-card combos — reuse `detectHandType` and the same combination enumeration already present in `valid-actions.ts` / `hand-comparison.ts`).
2. Prefer leading the **lowest** available combo of the **largest** size that does not break up a higher-value retained combo, using a simple scoring rule:
   - Among candidate plays, rank by `(sheds more cards) then (lower rank of the play)`.
   - **Combo-preservation guard:** never lead a *single* card that is a member of a pair/triple/straight the AI is holding intact, if a non-breaking single (a true singleton in the hand) is available. This satisfies "doesn't gratuitously break up combos."
3. **Hold the highest singles:** if leading a single, never lead a `2` (highest) or an `A` while a lower singleton exists. Lead the lowest true singleton.

**C3. Following (not free play, `lastPlay != null`).** The AI can either play a beating combo or pass:
1. If the AI **cannot** beat `lastPlay` (mirrors `canBeatLastPlay`), it **passes** (same as timeout — correct play).
2. If it **can** beat it, decide play-vs-pass with a light heuristic instead of always passing (the timeout bug):
   - **Play** the *minimal* combo that beats `lastPlay` (lowest winning combo of the required size) when any of:
     - the AI is "close to out" (hand size <= 5), or
     - the beating combo is cheap (its high card rank is at or below `J`), or
     - the AI holds the lead-relevant advantage: `consecutivePasses` indicates it would win the trick and get a free lead next (i.e. all other active players have already passed this trick — reuse `consecutivePasses` vs active count).
   - **Otherwise pass** to conserve a high/expensive winning combo (e.g. don't waste a 2 or a bomb to beat a low single early). This is a deliberate, bounded "hold high cards" behavior — not full strategy.
3. When playing to beat, always choose the **lowest** combo that legally beats `lastPlay` (never overpay), and honor the combo-preservation guard from C2.

**Determinism / tie-breaks.** All candidate enumeration iterates hand in `compareCards` order; ties resolve to the lowest card by `compareCards`. No randomness. Given identical own-hand + public state the choice is identical.

**Legality.** The chosen action is always one the engine accepts. The method asserts nothing at runtime, but it only ever emits (a) `pass` when passing is legal (C3.1, or the fallback), or (b) a `playCards` whose combination it derived from `detectHandType` and, when following, verified with `beats` — the exact predicates `applyAction` re-checks. If enumeration somehow yields no legal play in a must-play state (should be impossible: the hand always forms at least one single), fall back to the lowest single (never crashes, always legal).

### D. Tonk policy (`chooseTonkMove`)

Tonk turns are two-phase: `discard` then `draw`. `callTonk` is only offered in the discard phase once the TONK gate is open. Strategy by phase:

**D1. Discard phase.**
1. **Call TONK when worth it.** If `tonkGateOpen` and current `handValue(myHand)` is at or below a fixed threshold `TONK_CALL_THRESHOLD` (recommend **10** points — a strong low hand; the safe conservative bound is well under the 30-point TONK penalty), return `callTonk`. Rationale: a low hand is likely lowest at the table and calling captures the win; 10 is deliberately conservative so the AI only calls when it is genuinely strong, avoiding reckless calls that could backfire under Case-B/C scoring.
2. **Otherwise discard to minimize hand value.** Choose the discard that maximizes point reduction:
   - Compute, per discardable group, the total `cardValue` removed. A legal discard is one-or-more **same-rank** cards (jokers group only with jokers). Prefer discarding **all** copies of the single highest-total rank group present (e.g. dumping a pair of Kings removes 20 vs one King's 10) — this both lowers hand value fastest and is a natural, human-plausible play.
   - Tie-break by higher single-card value, then by `compareTonkCards` for full determinism (same order the timeout path uses).
   - Never discard jokers (value 0) unless the hand is all jokers (degenerate; then discard one joker by `compareTonkCards`).

**D2. Draw phase.**
1. **Draw from discard only when it strictly lowers the hand.** The `drawableDiscard` snapshot is public. Since a draw adds a card and the following discard removes one, the AI evaluates: would taking the drawable card let it discard something worth *more* than the drawable card's value on its *next* discard? Simplified deterministic rule (no lookahead): **draw from discard iff `cardValue(drawableDiscard) < min(cardValue over myHand)`** — i.e. the discard card is strictly cheaper than the cheapest card the AI already holds, so acquiring it and later shedding a costlier card lowers total value. Otherwise **draw from stock** (the default, and the only option when `drawableDiscard` is null or stock draw is forced).
2. If `stockCount === 0` the only legal draw is `stock` (engine treats it as stock-out / trick end) — the policy returns `draw:stock`, matching the timeout path, so stock-out resolves identically.

**Determinism.** `handValue`, `cardValue`, and `compareTonkCards` are all pure and already used by the engine. The threshold is a compile-time constant. No randomness.

**Legality.** `callTonk` is only returned when `tonkGateOpen` (the exact gate `applyAction` re-checks). Discards are always same-rank subsets of the hand. Draws are always a legal source. If, defensively, no discard can be formed (empty hand — impossible for the current seat in a live trick), fall back to `getAutoTimeoutAction`'s choice for that state.

### E. Socket-layer routing (the AI-only seam)

Today `autoPlayAbandoned` (`socketHandler.ts` ~line 178) calls `engine.getAutoTimeoutAction(currentState)` for **every** driven seat (AI or abandoned human). Change the loop to branch on seat type:

- Inside the loop, after confirming `shouldAutoPlay`, resolve whether the current seat is an AI seat via the existing `gameService.isAiSeat(gameId, playerId)` (already awaited elsewhere in the loop context; the memoized set makes this hot-path-cheap).
- **AI seat → `engine.getAiMoveAction(currentState)`.**
- **Abandoned human → `engine.getAutoTimeoutAction(currentState)`** (unchanged).

Concretely:

```ts
const isAi = await gameService.isAiSeat(gameId, currentPlayer.playerId);
const autoAction = isAi
  ? engine.getAiMoveAction(currentState)
  : engine.getAutoTimeoutAction(currentState);
```

All downstream handling (null → fallback timer, apply, completion broadcast, divergence guard) is unchanged — `getAiMoveAction` obeys the same null/legality contract as `getAutoTimeoutAction`, so it is a drop-in at that one call site.

**`handleTimerExpired` (~line 726) is NOT changed.** It fires only when a *human's* turn timer expires (an abandoned/slow human) and must keep using `getAutoTimeoutAction`. AI seats never arm a real human turn timer (per LLD 118 §C, the AI-first `startTurn(true)` is skipped and AI turns are driven by the loop), so the timer-expiry path is never an AI seat. This preserves the acceptance criterion "abandoned-seat timeout behavior is unchanged."

**Why not add a third `shouldAutoPlay`-style predicate.** The loop already computes `shouldAutoPlay`; adding the `isAiSeat` check there (already memoized) is the minimal, lowest-blast-radius change. No new predicate, no new call site.

## Interfaces / Types

**`src/backend/engine/game-engine.ts` — add to `GameEngine`:**

```ts
getAiMoveAction(state: InternalGameState): GameAction | null;
```

Implemented by both `Big2Engine` and `TonkEngine`. Same null contract as `getAutoTimeoutAction`.

**`src/backend/engine/big2/` — new pure policy module (recommend `ai-policy.ts`):**

```ts
export function chooseBig2Move(
  myHand: readonly Card[],
  pub: Big2PolicyView,
): Big2Action;

interface Big2PolicyView {
  readonly lastPlay: Big2Play | null;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly lowestCard: Card;          // mandated first-play card, from engine helper
  readonly consecutivePasses: number;
  readonly activePlayerCount: number; // players - finished, for trick-win detection
}
```

`Big2Engine.getAiMoveAction` builds `Big2PolicyView` from `Big2State` + `state.players.length`/`finishedPlayerIndices` and passes only `hands[currentPlayerIndex]` as `myHand`.

**`src/backend/engine/tonk/` — new pure policy module (recommend `ai-policy.ts`):**

```ts
export function chooseTonkMove(
  myHand: readonly TonkCard[],
  pub: TonkPolicyView,
): TonkAction;

interface TonkPolicyView {
  readonly turnPhase: TonkTurnPhase;
  readonly tonkGateOpen: boolean;
  readonly drawableDiscard: TonkCard | null;
  readonly stockCount: number;
}

const TONK_CALL_THRESHOLD = 10; // hand-value at/below which the AI calls TONK
```

`TonkEngine.getAiMoveAction` builds `TonkPolicyView` from `TonkState` + `isTonkGateOpen(...)` and passes only `hands[currentPlayerIndex]` as `myHand`.

**`src/backend/websocket/socketHandler.ts`:** one call-site change inside `autoPlayAbandoned` (see §E). No signature changes. No change to `handleTimerExpired`.

No changes to shared types, `PlayerView`, DB, or `GameConfig`.

## State Model

- **No new state.** The policy is a pure derivation from `InternalGameState`; it persists nothing and mutates nothing. `getAiMoveAction` returns a `GameAction` that flows through the existing `gameService.applyAction` path exactly like a timeout action.
- **In-memory / persisted:** unchanged from LLD 118. AI-seat membership still lives in `gameConfig.aiPlayerIds` (memoized post-start). The engine remains oblivious to "AI" — `getAiMoveAction` acts for `state.currentPlayerIndex` regardless of who occupies it; the socket layer decides *when* to call it (AI seat) vs `getAutoTimeoutAction` (abandoned human).
- **Purity:** no PRNG. Unlike `initialize`/`endTrick` which use `SeededPRNG`, the policy takes no randomness — it is a deterministic function of the visible state (architecture principle 4 + 8).

## Edge Cases

1. **Big2 first play with only a single low card usable.** Hand has no combo/pair containing the mandated lowest card → play the lowest single (C1.3). Legal, matches the mandatory-lowest rule.
2. **Big2 following, cannot beat lastPlay.** Policy returns `pass` (C3.1) — same as timeout, correct.
3. **Big2 following, can beat but holding only a `2`/bomb over a cheap low single early.** Policy passes to conserve (C3.2 "otherwise pass"), *unless* hand size <= 5 or it would win the trick lead — then it plays minimal. Never overpays.
4. **Big2 free play (must play).** Never returns `pass` (illegal). Leads lowest non-combo-breaking play; falls back to lowest single if no other candidate (always exists).
5. **Big2 AI at a finished index.** Not reachable — `getValidActions`/loop skip finished seats via `getNextActivePlayerIndex`; `currentPlayerIndex` is always a live seat when the loop calls the policy. If constructed anyway, `myHand` empty → fall back to lowest-single logic returns null (same null contract as timeout), loop arms fallback timer.
6. **Tonk discard, hand value already <= threshold and gate open.** Returns `callTonk` (D1.1). If gate not open, cannot call → discards to minimize (D1.2).
7. **Tonk discard, best reduction is a multi-card same-rank group.** Discards all copies of the highest-total rank group (D1.2). Legal (same-rank multi-discard is allowed).
8. **Tonk draw, `drawableDiscard` null (trick start with no snapshot / after own multi-discard scenarios).** Only stock draw is sensible/legal → `draw:stock` (D2).
9. **Tonk draw, stock empty (`stockCount === 0`).** Returns `draw:stock`; engine resolves stock-out / trick end. Identical to timeout path (D2.2).
10. **Tonk draw, drawable card cheaper than cheapest held card.** Draws from discard (D2.1). Otherwise stock. Jokers (value 0) held: `min` held value is 0, so drawable (>=1) is never strictly cheaper → the AI keeps its jokers and draws stock, which is correct (jokers are the best cards to hold).
11. **Game completes on an AI policy move inside the loop.** Unchanged from LLD 118 edge case 6: loop's COMPLETED branch fires, stats routed through `applyAction` with `practice=true` (skipped). The policy move is just a normal completing action.
12. **`getAiMoveAction` returns null for a live AI seat.** Loop arms the fallback timer (existing B1 handling). Only reachable via a constructed/degenerate state; normal Big2/Tonk always produces a legal move.
13. **Abandoned human in the same game as AI seats.** Loop drives the human via `getAutoTimeoutAction` (isAi false) and the AI seats via `getAiMoveAction` (isAi true) — the two paths coexist in one loop pass, each seat routed correctly. Abandoned-human behavior is untouched.
14. **Determinism under re-drive.** If the loop re-enters the same state (e.g. after a fallback timer), the policy returns the identical action (pure) — no oscillation introduced.

## Dependencies

- **Must exist (all present on `main` via #118/#137/#138):** `GameEngine` interface with `getAutoTimeoutAction`; `Big2Engine`/`TonkEngine`; `valid-actions.ts` (`canBeatLastPlay`, `computeValidActions`, `isValidPlay`), `hand-detection.ts` (`detectHandType`), `hand-comparison.ts` (`beats`), `constants.ts` (`compareCards`, lowest-card logic); Tonk `constants.ts` (`cardValue`, `handValue`, `compareTonkCards`), `turn.ts` (`isTonkGateOpen`), `valid-actions.ts` (`validateDiscard`); `gameService.isAiSeat` (memoized); `autoPlayAbandoned` loop and `shouldAutoPlay` seam.
- **No new migration, no schema change, no new dependency package.**
- **Blocks nothing further** — this is a leaf quality improvement on the #127 epic. #120's create-game/lobby AI UI is independent and already merged.

## Test Requirements

Follow testing-principles: pure engine tests, no server/DB/network, self-contained (no shared `beforeEach` game state), direct state construction via existing helpers (`tests/engine/big2/*` inline builders, `tests/engine/tonk/helpers.ts` `buildTonkState`). No manual test table — all automated. Existing `getAutoTimeoutAction` tests must remain green (proves the timeout path is unchanged).

### Unit — Big2 policy (`getAiMoveAction` / `chooseBig2Move`)
- **Always legal:** for a spread of constructed states (first play, free play, following-can-beat, following-cannot-beat) assert `engine.validateAction(state, engine.getAiMoveAction(state)!)` is true, and `applyAction(...).success` is true.
- **Does not always pass (core bug fix):** in a following position where the AI *can* beat a cheap low single and is close to out (hand <= 5) → asserts it **plays** (not `pass`). Contrast a symmetric timeout call still returns `pass` (regression guard on `getAutoTimeoutAction`).
- **Sheds low early:** first-play state → the returned play includes the mandated lowest card and, when a low combo/pair exists containing it, sheds >1 card.
- **Holds high cards:** free-play/lead state where the hand has a low singleton and a `2` → asserts it leads the low singleton, not the `2`.
- **Combo preservation:** lead state where the only low card is part of an intact pair and a separate true singleton exists → asserts it does not break the pair to lead a single.
- **Passes when it cannot beat:** following state with no beating combo → `pass` (matches timeout here, correct).
- **Information hiding:** construct two states identical except opponents' hidden hands differ (swap in high/low cards for other seats) → assert `getAiMoveAction` returns the **same** action for both; plus the standard `getPlayerView` leak assertion is unaffected.

### Unit — Tonk policy (`getAiMoveAction` / `chooseTonkMove`)
- **Always legal:** across discard-phase (gate open / closed) and draw-phase (stock available / empty, drawable present / null) constructed states, assert the returned action is accepted by `applyAction`.
- **Discards to minimize value:** discard-phase hand with a high pair (e.g. two Kings) and low singles → asserts it discards the highest-total group (both Kings), reducing hand value most; tie-break deterministic via `compareTonkCards`.
- **Calls TONK when low enough:** gate open + `handValue <= TONK_CALL_THRESHOLD` → returns `callTonk`. Gate open but `handValue` above threshold → does **not** call (discards instead). Gate closed + low hand → discards (cannot call).
- **Draws from discard only when it lowers the hand:** draw-phase where `drawableDiscard` value < cheapest held card → `draw:discard`; where drawable value >= cheapest held → `draw:stock`. Joker-in-hand case → `draw:stock` (keeps joker).
- **Stock-out:** draw-phase with `stockCount === 0` → `draw:stock` (matches timeout).
- **Information hiding:** vary other seats' hands between two otherwise-identical states → identical returned action.

### Integration — full-game simulation to `COMPLETED` (both engines, seeded)
- **Big2, 1 human + 1 AI (seeded PRNG):** drive via the loop mechanism with the AI seat on `getAiMoveAction` and the "human" following a legal pick-from-`validActions` strategy. Assert: (a) every applied action legal, (b) invariants after each action (card conservation, current player active, status monotonic), (c) terminates at `COMPLETED` with a winner + scores. Assert the AI produced **at least one** play in a following position where `getAutoTimeoutAction` would have passed (proves the policy is exercised and non-trivial), i.e. the AI's move stream is **not** identical to the all-timeout stream.
- **Tonk, 1 human + 2 AI (seeded PRNG):** same invariants; runs multiple tricks to match end (`trueLoser` resolved). Assert the AI called TONK or drew-from-discard at least once across the game (policy exercised, distinct from the draw-stock/discard-highest timeout stream).

### Socket-layer routing (targeted, alongside existing `socketHandler.test.ts`)
- In `autoPlayAbandoned`, an **AI seat** invokes `getAiMoveAction` and an **abandoned human** invokes `getAutoTimeoutAction` (assert via engine spies / stubbed `isAiSeat`): verifies the branch routes correctly and the abandoned-human path is unchanged.
- `handleTimerExpired` still calls `getAutoTimeoutAction` (never `getAiMoveAction`) — abandoned/timeout behavior unchanged.
