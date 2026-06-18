# Testing Principles — Card Game Engine

Stateless guidance for testing decisions. Derived from research into Terraforming Mars, boardgame.io, and game engine testing patterns.

---

## 1. Test the Engine as Pure Functions

**Principle:** Game engine functions are `(state, action) → newState`. Test them as such — no server, no network, no database.

- Import engine functions directly into tests and call them with constructed state.
- Don't boot Express, don't connect to a database, don't open a WebSocket just to test game rules.
- The engine has no I/O, so tests should have no I/O either.

**Why:** boardgame.io states: "Moves are just functions, so they lend themselves to unit testing." Terraforming Mars tests instantiate cards and game state inline with zero infrastructure. This makes tests fast (milliseconds) and reliable (no flaky network dependencies).

---

## 2. Control Randomness

**Principle:** Tests must be deterministic. Eliminate randomness via one of two approaches:

- **Seeded PRNG:** Pass a seed to the random number generator. Same seed = same shuffle every time. Preferred for integration-style tests where you want realistic but reproducible game flow.
- **Disable shuffling:** Monkey-patch or flag-disable shuffle operations entirely. Preferred for unit tests where you need specific card arrangements.

Never use `Math.random()` directly in game logic. Route all randomness through an injectable source that tests can control.

**Why:** Terraforming Mars uses `skipInitialShuffling` to disable deck shuffling in tests. boardgame.io uses a seed-based PRNG system (`seed: 42`) making all random calls deterministic. Both approaches enable reproducible test results.

---

## 3. Self-Contained Tests (No Shared State)

**Principle:** Each test creates its own game instance and players inline. No `beforeEach` hooks that set up shared game state across tests.

- Each `it` block constructs exactly the state it needs.
- No describe-scoped mutable variables that accumulate state across tests.
- If a test fails, you can run it in isolation and it still fails — no ordering dependencies.

**Why:** Terraforming Mars's `Game.spec.ts` contains ~48 test blocks with zero `beforeEach`/`afterEach` hooks and zero shared variables. Each test independently creates players and game instances. This eliminates "test A passes alone but fails when test B runs first" bugs.

---

## 4. Direct State Manipulation Over Replay

**Principle:** Use helper functions to set preconditions directly rather than replaying long action sequences to reach a state.

- Write helpers like `setHandTo(player, cards)`, `setTurnTo(playerId)`, `setDeckTo(cards)`.
- Don't replay 20 moves to reach the state where a specific edge case occurs — construct that state directly.
- Helpers should manipulate the same internal state shape the engine uses (not a parallel test-only model).

**Why:** Terraforming Mars imports helpers like `setTemperature()`, `setOxygenLevel()`, `maxOutOceans()` that directly set game state. This avoids brittle tests that break when unrelated early-game logic changes, and makes tests faster and more readable.

---

## 5. Extend Real Classes for Test Doubles

**Principle:** Test helpers should extend production classes, not replace them with mocks.

- Create a `TestPlayer` that extends the real `Player` class, adding inspection utilities.
- Create `TestGameOptions` that extends real `GameOptions` with test-specific flags.
- Avoid mocking frameworks for core game objects — they hide real behavior and create false confidence.

**Why:** Terraforming Mars's `TestPlayer` extends the real `Player` class, adding `popWaitingFor()` for action queue inspection and `TestTags` for simulating card states. This means tests exercise real production code paths, not mock behavior.

---

## 6. Test Invalid Actions Explicitly

**Principle:** For every valid action, test that the corresponding invalid cases are rejected gracefully.

- Wrong player's turn → rejected
- Action not in `validActions` set → rejected
- Invalid payload (e.g., cards not in hand, illegal combination) → rejected
- Action after game is over → rejected
- State should not change after a rejected action (state ID / version unchanged)

**Why:** boardgame.io tests verify that on invalid moves "state ID does not increment and specific error messages are logged (not thrown)." This catches real bugs where validation has gaps — a player could submit a modified request to perform illegal actions.

---

## 7. Test Per-Player Views for Information Leakage

**Principle:** Assert that filtered player views never contain information the player shouldn't see.

- After dealing, verify that `getPlayerView(state, playerA)` does NOT contain playerB's hand.
- Verify that the only cards visible are: your own hand, public piles, and card counts (not contents) of opponents.
- Write negative assertions: `expect(playerAView).not.toContain(playerBCard)`.

**Why:** Information hiding is the primary security measure (see architecture-principles.md). If a test can observe another player's cards through the view, so can a cheating client inspecting network traffic.

---

## 8. Test Game Invariants Across All States

**Principle:** Define invariants that must hold after every action, and assert them broadly.

Invariants for a card game:

- Total cards in the system (all hands + deck + discard + played) = expected total (no cards created or destroyed)
- Current turn player is always one of the active players
- `validActions` is never empty for the current player (the game isn't stuck)
- Game status transitions are one-directional (CREATED → IN_PROGRESS → COMPLETED, never backwards)

Run these invariant checks after every action in integration tests (play full games and assert invariants hold at each step).

**Why:** Invariant violations reveal edge-case bugs that targeted tests miss. "Total cards in system is constant" catches off-by-one bugs in draw/discard logic that scenario-based tests might never hit.

---

## 9. Full Game Simulations as Integration Tests

**Principle:** Write at least one test that plays a complete game from start to finish using only valid actions.

- Use seeded randomness for reproducibility.
- At each step, pick from `validActions` (randomly or following a simple strategy).
- Assert invariants hold after every action.
- Assert the game terminates (doesn't loop forever).
- Assert a winner is declared and scoring is correct.

This is your smoke test — if a full game can be played without crashing or entering an invalid state, the engine is fundamentally sound.

**Why:** Unit tests verify individual rules. Integration tests verify that rules compose correctly. A game that passes all unit tests but deadlocks on turn 7 of an actual game has a composition bug that only full simulation reveals.

---

## 10. Organize Tests by Game Concept

**Principle:** Structure test files around game concepts, not implementation files.

Suggested structure:

```
tests/
  engine/
    cards.test.ts              — deck creation, shuffle, deal
    big2/
      combinations.test.ts     — single, pair, 5-card hand detection + ranking
      validation.test.ts       — valid/invalid action cases
      gameFlow.test.ts         — turn order, trick reset, passing
      scoring.test.ts          — end-game scoring calculation
      fullGame.test.ts         — complete game simulation
  helpers/
    TestGame.ts                — test game factory with controlled randomness
    TestPlayer.ts              — extended player with inspection utilities
    stateHelpers.ts            — direct state manipulation functions
```

**Why:** Terraforming Mars organizes tests by card (one spec file per card) because cards are their primary complexity unit. For Big2, complexity lives in combination ranking and game flow, so organize around those concepts.

---

## Decision Heuristics

When deciding what to test:

1. **Test rules that have edge cases.** If a rule has conditions ("except when..."), it needs a test for the exception.
2. **Test boundaries.** Min/max players, empty deck, last card played, timeout at zero.
3. **Test the security boundary.** Any action a client can submit must be validated. Test that invalid submissions are rejected.
4. **Don't test framework behavior.** Don't test that Express routes work or that Socket.IO emits events — those are library responsibilities.
5. **Don't test trivial getters/setters.** If it's just `return this.field`, it doesn't need a test.
6. **Bias against manual tests.** If behavior can be verified with an automated unit or integration test, write one. Only specify manual test steps for things that genuinely require visual/UX verification (animations, layout, responsiveness) and cannot be covered by checking computed state or DOM assertions. An LLD's test section should be mostly automated tests; a manual test table is the exception, not the default.

Minimum effective strategy for a solo dev: comprehensive unit tests for the game engine (rules, validation, scoring), one full-game integration test, and invariant checks. Skip UI tests until the game logic is stable.
