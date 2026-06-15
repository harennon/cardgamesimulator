# LLD: Test Coverage Gaps — State Seeding & Missing Tests

## Scope

### Covered

1. **State seeding helper** — a utility for tests to put games into any desired state (CREATED, IN_PROGRESS, COMPLETED) without playing through the full game flow.
2. **E2E tests** — game over screen rendering, guest sign-up nudge, board-to-game-over transition, lobby UI behaviors, join game error states.
3. **Integration tests** — invalid card combo rejection via WebSocket, totalScore correctness, joinGame when full, game:start with too few players.

### Not Covered

- Spectator E2E tests (spectating flow is not fully wired to frontend yet).
- Rematch flow tests (rematch button is currently disabled in UI).
- Performance/load testing.
- Frontend-only unit tests for Vue components.

---

## Approach

### State Seeding Strategy

The core problem: verifying behaviors that require a game in a specific state (COMPLETED, mid-game with specific hands, etc.) is impractical via full game replay in E2E tests. The solution is a **state seeding helper** with two access levels:

1. **Integration tests** — direct in-process access. The test helper calls `gameCache.set()` and writes to the DB directly via the `gameRepo`. This is straightforward since integration tests already have access to `testServer` internals.

2. **E2E tests** — REST endpoint `POST /test/seed-state`. Playwright cannot access in-process state, so E2E tests hit a REST endpoint that seeds the game cache and DB. This endpoint only exists when `NODE_ENV=test`.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| REST endpoint for E2E seeding (not WebSocket) | Playwright has native `request.post()` — simpler than managing a socket connection for setup |
| Partial state + defaults pattern | Callers provide only the fields they care about; the helper merges with sensible defaults (valid Big2 state with dealt hands) |
| Seed both cache AND DB | GameView fetches via REST `getGameState` first (hits DB), then Socket.IO broadcasts from cache. Both must agree. |
| Gate endpoint behind `NODE_ENV=test` | Production safety — never expose state manipulation in non-test environments |
| Expose `gameCache` and `gameService` on `TestServerContext` | Integration tests need direct cache/service access for seeding |

---

## Interfaces / Types

### State Seeding Helper (shared between integration and E2E)

```typescript
// tests/helpers/seedState.ts

import type {
  InternalGameState,
  GameStatus,
  GameType,
  PlayerInfo,
  PlayerScore,
  Card,
} from "@shared/engine-types";
import type { Big2InternalState } from "../../src/backend/engine/big2/big2-types";

/**
 * Partial state that callers provide. All fields optional except gameId.
 * The helper fills defaults for anything not specified.
 */
export interface SeedGameOptions {
  gameId: string;
  status?: GameStatus;          // default: "IN_PROGRESS"
  gameType?: GameType;          // default: "big2"
  players?: PlayerInfo[];       // default: 4 players with generated IDs
  currentPlayerIndex?: number;  // default: 0
  turnNumber?: number;          // default: 1
  winner?: string | null;       // default: null
  scores?: PlayerScore[] | null; // default: null
  hands?: Card[][];             // default: dealt from a standard deck
  gameSpecificState?: Partial<Big2InternalState>; // merged with defaults
}

/**
 * Build a complete InternalGameState from partial options.
 * Ensures all invariants hold (card counts, player indices, etc.)
 */
export function buildGameState(options: SeedGameOptions): InternalGameState;

/**
 * Build a COMPLETED game state with scores.
 * Convenience wrapper for game-over scenarios.
 */
export function buildCompletedState(options: {
  gameId: string;
  players: PlayerInfo[];
  winner: string;
  scores: PlayerScore[];
}): InternalGameState;
```

### E2E Seed Endpoint

```typescript
// src/backend/api/test/seedState.ts (only loaded when NODE_ENV=test)

import { Router } from "express";

export interface SeedStateRequest {
  gameId: string;
  state: Partial<InternalGameState>;
  dbFields?: {
    status?: GameStatus;
    playerIds?: string[];
    playerDisplayNames?: Record<string, string>;
    maxPlayers?: number;
    turnTimerSeconds?: number | null;
  };
}

export interface SeedStateResponse {
  success: boolean;
  gameId: string;
}

/**
 * POST /test/seed-state
 * Seeds the game cache and optionally updates the DB record.
 * Only available when NODE_ENV=test.
 */
export function createSeedStateRouter(
  gameCache: GameCache,
  gameRepo: GameRepository,
): Router;
```

### TestServerContext Extension

```typescript
// Addition to tests/integration/helpers/testServer.ts

export interface TestServerContext {
  // ... existing fields ...
  gameCache: GameCache;
  gameService: GameService;
}
```

### E2E Seed Helper

```typescript
// e2e/helpers/seed-helpers.ts

import type { APIRequestContext } from "@playwright/test";

/**
 * Seed a game into a specific state via the test API.
 * Call from Playwright tests to set up scenarios without playing through the game.
 */
export async function seedGameState(
  request: APIRequestContext,
  options: SeedStateRequest,
): Promise<void>;

/**
 * Seed a completed game state with scores and winner.
 */
export async function seedCompletedGame(
  request: APIRequestContext,
  options: {
    gameId: string;
    players: Array<{ id: string; displayName: string }>;
    winner: string;
    scores: Array<{ playerId: string; score: number }>;
  },
): Promise<void>;
```

---

## State Model

### Seeding Flow for E2E Tests

```
Playwright test
  │
  ├── 1. Create game via REST (POST /createGame) → gets gameId
  ├── 2. Join players via REST (POST /joinGame) → registers players in DB
  ├── 3. Seed state via REST (POST /test/seed-state) → injects desired state
  │       ├── Writes InternalGameState to gameCache
  │       ├── Updates Game entity in DB (status, state JSON)
  │       └── Returns success
  └── 4. Navigate browser to /game/:gameId → frontend fetches state, renders
```

### Seeding Flow for Integration Tests

```
Vitest test
  │
  ├── 1. Create game via REST (POST /createGame through ctx.app)
  ├── 2. Join players via REST (POST /joinGame through ctx.app)
  ├── 3. Seed state directly:
  │       ├── ctx.gameCache.set(gameId, builtState)
  │       └── gameRepo.saveGame(updatedGameEntity)   (if DB consistency needed)
  └── 4. Connect sockets, emit game:join → receives seeded state
```

### State Defaults for `buildGameState`

When `status === "IN_PROGRESS"`:
- 4 players with UUIDs unless overridden
- 13 cards per hand (standard Big2 deal) unless `hands` provided
- `currentPlayerIndex: 0`
- `isFreePlay: true`, `isFirstPlayOfGame: true`, `lastPlay: null`

When `status === "COMPLETED"`:
- `winner` must be set (throw if not)
- `scores` must be set (throw if not)
- All hands empty (winner) or with leftover cards (losers)
- `finishedPlayerIndices` computed from scores ordering

---

## E2E Test Specifications

### File: `e2e/game-over.spec.ts`

**Test 1: Game over screen renders with scores and winner**
- Setup: Create game, join 2 players, seed COMPLETED state with scores `[{p1: 5}, {p2: 0}]`.
- Navigate player1's browser to `/game/:gameId`.
- Assert: `[data-testid="game-over"]` is visible.
- Assert: Winner display name text is present in `game-over__winner`.
- Assert: Score table shows correct placement (1st, 2nd), points (5, 0).
- Assert: "Back to Home" button is visible and clickable.

**Test 2: Game over screen — guest sees sign-up nudge**
- Setup: Create game, host = registered, player2 = guest. Seed COMPLETED state.
- Navigate guest's browser to `/game/:gameId`.
- Assert: `game-over__guest-nudge` is visible, contains "Sign up" link.

**Test 3: Game over screen — registered user does NOT see sign-up nudge**
- Setup: Create game, both players registered. Seed COMPLETED state.
- Navigate player's browser to `/game/:gameId`.
- Assert: `game-over__guest-nudge` is NOT visible.

**Test 4: Game board to game-over transition**
- Setup: Create game, join 2 players, start game (real start).
- Seed IN_PROGRESS state where player1 has 1 card left and it is their turn, free play.
- Player1 plays their last card via WebSocket action.
- Assert: Both players see `[data-testid="game-over"]` appear (transition from game board).

### File: `e2e/lobby.spec.ts` (additions to existing)

**Test 5: Copy invite link button exists**
- Setup: Create game, navigate host to lobby.
- Assert: `[data-testid="copy-invite-button"]` is visible.
- Click it.
- Assert: "Copied!" feedback appears.

**Test 6: Start button disabled with only 1 player**
- Setup: Create game (maxPlayers=4), only host in lobby.
- Assert: `[data-testid="start-game-button"]` is visible but disabled.

### File: `e2e/join-game.spec.ts` (additions to existing)

**Test 7: Joining a full game shows "game full" error**
- Setup: Create game (maxPlayers=2), join 2 registered players via REST.
- A third player navigates to `/join-game`, enters the game code.
- Assert: Error message shown (the `AlreadyExistsError` returned by joinGame handler, which the frontend renders as a user-facing error).

---

## Integration Test Specifications

### File: `tests/integration/game-actions.test.ts`

**Test 1: Invalid card combo rejected with error message via WebSocket**
- Setup: Create 2-player game, start it.
- Identify current player. Attempt to play 2 cards that do not form a valid combo (e.g., 3-clubs + 7-hearts as first play — not a pair, not a single).
- Assert: `game:action` ack returns `{ success: false, error: "..." }` where error contains "INVALID" or describes the rejection.
- Assert: Game state version does NOT increment (state unchanged).

**Test 2: Invalid card combo — cards not in hand**
- Setup: Same as above.
- Attempt to play a card the player does not hold.
- Assert: Rejection with error.

### File: `tests/integration/scoring.test.ts`

**Test 3: totalScore matches Big2 placement scoring (5/3/1/0)**
- Setup: Create 4-player game, start it. Play to completion (use existing `pickCardsToPlay` strategy or seed near-completion state).
- Assert: `scores` in final state contains exactly 4 entries.
- Assert: Scores are exactly [5, 3, 1, 0] in placement order.
- Assert: Winner's score is 5.

**Test 4: 2-player scoring is [5, 0]**
- Setup: Create 2-player game, play to completion via timer expiry.
- Assert: Scores are [5, 0].

### File: `tests/integration/game-lifecycle.test.ts`

**Test 5: joinGame rejected when game is full**
- Setup: Create game (maxPlayers=2), join 2 players.
- Third player attempts `POST /joinGame`.
- Assert: Response status is 409 (AlreadyExistsError).

**Test 6: game:start rejected with fewer than min players**
- Setup: Create game (maxPlayers=4), only host joined.
- Host emits `game:start`.
- Assert: Ack returns `{ success: false, error: "NOT_ENOUGH_PLAYERS" }`.

**Test 7: joinGame on IN_PROGRESS game**
- Setup: Create 2-player game, join both, start game.
- Third player attempts `POST /joinGame`.
- Assert: Response status is 409 (game is full — maxPlayers reached).

---

## File Organization

```
tests/
  helpers/
    seedState.ts              — buildGameState(), buildCompletedState()

tests/integration/
  helpers/
    testServer.ts             — MODIFIED: expose gameCache, gameService
  game-actions.test.ts        — NEW: invalid combo tests
  scoring.test.ts             — NEW: placement scoring tests
  game-lifecycle.test.ts      — NEW: full/start rejection tests

src/backend/api/test/
  seedState.ts                — NEW: POST /test/seed-state (NODE_ENV=test only)

e2e/
  helpers/
    seed-helpers.ts           — NEW: seedGameState(), seedCompletedGame()
  game-over.spec.ts           — NEW: game over screen E2E tests
  lobby.spec.ts               — NEW: lobby button behavior tests
  join-game.spec.ts           — NEW: game full error test
```

---

## Edge Cases

1. **Seeding a game that does not exist in DB** — The seed endpoint must reject with 404. The game must first be created via `POST /createGame` to establish the DB record. The seed only overwrites state, not creates the record.

2. **Seeding state with inconsistent playerIds** — If the seeded state references playerIds not in the DB `Game.playerIds`, the frontend will fail to load. The seed helper should validate that `state.players[].playerId` matches the DB record's `playerIds`, or update both atomically.

3. **Cache/DB divergence** — The seed endpoint must write to BOTH the game cache AND the DB. If only one is updated, the system will behave inconsistently (REST reads from DB, WebSocket reads from cache).

4. **E2E test isolation** — Each E2E test creates its own game. No shared game state between tests. The seed endpoint operates on a specific gameId, so parallel tests on different games do not interfere.

5. **Endpoint leaking to production** — The seed endpoint is conditionally registered only when `NODE_ENV=test`. The implementer must ensure the import is dynamic (not a top-level import that bundles the code regardless of env). In the test server (`testServer.ts`), this is naturally gated. For the E2E server launched via Playwright config, the env var is already set to `"test"`.

6. **Game over transition timing** — The E2E test for board-to-game-over transition must wait for WebSocket state update to propagate. Use `page.waitForSelector('[data-testid="game-over"]')` with appropriate timeout rather than asserting immediately after the action.

---

## Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| `GameCache` class | Exists | `src/backend/engine/game-cache.ts` |
| `GameService` class | Exists | `src/backend/service/gameService.ts` |
| `testServer.ts` infrastructure | Exists | Needs minor extension to expose `gameCache` and `gameService` |
| Game entity + TypeORM repo | Exists | `src/backend/database/entities/Game.ts` |
| GameOverView component | Exists | `src/frontend/component/game/GameOverView.vue` — has `data-testid="game-over"` |
| GameLobbyView component | Exists | Has `data-testid="start-game-button"`, `data-testid="copy-invite-button"` |
| Playwright global setup | Exists | Creates test users, stores auth state |
| E2E game helpers | Exists | `e2e/helpers/game-helpers.ts` — `createGame()`, `joinAsGuest()` |
| Big2 scoring logic | Exists | `src/backend/engine/big2/scoring.ts` with `PLACEMENT_POINTS` |
| `NODE_ENV=test` in Playwright config | Exists | Already set in `playwright.config.ts` webServer env |

---

## Implementation Notes

### Exposing `gameCache` and `gameService` on TestServerContext

The `createTestServer()` function already creates `gameCache` and `gameService` locally. Add them to the returned context object:

```typescript
// In testServer.ts, add to the return object:
return {
  app,
  httpServer,
  io,
  baseUrl,
  timerProvider,
  turnTimerService,
  connectionManager,
  gameCache,     // ADD
  gameService,   // ADD
  close,
};
```

### Registering the Seed Endpoint for E2E

In the production `Server` class, add a conditional route:

```typescript
// At the end of route registration in server.ts:
if (process.env.NODE_ENV === "test") {
  const { createSeedStateRouter } = await import("@/api/test/seedState");
  this.app.use("/test/seed-state", createSeedStateRouter(gameCache, gameRepo));
}
```

This uses dynamic import so the module is not loaded in production builds.

### Default Hand Generation for `buildGameState`

The helper should use the existing `createDeck()` and `dealCards()` from `src/backend/engine/big2/deck.ts` with a fixed seed to generate deterministic default hands. This ensures the seeded state is internally consistent (total cards = 52, no duplicates).

### AlreadyExistsError HTTP Status

The existing `JoinGameHandler` throws `AlreadyExistsError` when the game is full. The `errorHandler` middleware maps this to HTTP 409. The frontend join-game page should display a user-facing error for this case. If it does not currently render 409 as "This game is full", that is a minor frontend fix needed alongside this work.

---

## Test Requirements

### Unit Tests (for the seed helper itself)

- `buildGameState` with no overrides produces a valid 4-player IN_PROGRESS state.
- `buildGameState` with `status: "COMPLETED"` requires `winner` and `scores`.
- `buildGameState` with custom `hands` preserves them exactly.
- `buildCompletedState` produces scores matching input.

### Integration Tests (new tests in this LLD)

- Invalid card combo rejected — ack has `success: false`.
- Cards not in hand rejected — ack has `success: false`.
- Scoring is [5, 3, 1, 0] for 4 players.
- Scoring is [5, 0] for 2 players.
- JoinGame on full game returns 409.
- game:start with 1 player returns NOT_ENOUGH_PLAYERS.
- JoinGame on IN_PROGRESS game when full returns 409.

### E2E Tests (new tests in this LLD)

- Game over screen renders with scores table.
- Guest sees sign-up nudge on game over.
- Registered user does not see sign-up nudge.
- Board-to-game-over transition fires on last card played.
- Copy invite link button visible and triggers clipboard.
- Start button disabled with only 1 player.
- Full game shows error on join attempt.

### Security

- `POST /test/seed-state` returns 404 (or is not registered) when `NODE_ENV !== "test"`.
- Seed endpoint is not importable via production entry point.
