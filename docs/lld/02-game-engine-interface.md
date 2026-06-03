# LLD 2: Game Engine Interface

The contract that all game engines implement, plus shared types, injectable randomness, game cache, and concurrency strategy.

---

## 1. Scope

**In scope:**
- `GameEngine` interface with full method signatures and behavioral contracts
- Shared card types (Card, Suit, Rank)
- Game action and result types (GameAction, ActionResult)
- State types (InternalGameState, PlayerView, SpectatorView)
- State machine conventions and valid action declarations
- PRNG interface and seeded implementation
- GameEngineFactory (maps gameType to engine instance)
- In-memory game cache (Map-based, with eviction)
- Concurrency strategy (optimistic locking via version field)

**Out of scope:**
- Big2-specific rules and logic (LLD 4)
- WebSocket layer (LLD 3)
- Database schema and persistence (LLD 1)
- Frontend rendering of game state (LLD 6)
- Turn timer implementation (LLD 7)
- Specific game actions (play cards, pass, draw) — those are game-specific

---

## 2. Type Definitions

All types in this section go to `src/shared/engine-types.ts` (shared between frontend and backend).

### 2.1 Card Types

```typescript
// Standard playing card suits
export type Suit = "clubs" | "diamonds" | "hearts" | "spades";

// Standard playing card ranks (string literals for readability)
export type Rank = "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A" | "2";

// A single playing card — immutable value object
export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
}
```

**Design notes:**
- `Rank` uses Big2-compatible ordering (3 lowest, 2 highest). The array index of the rank in a constant array determines numeric value for comparisons — that logic lives in the Big2 engine, not here.
- Cards are value objects: two cards with the same suit and rank are equal. Engines must compare by value, not reference.
- The `Card` type is game-agnostic. Games that need non-standard decks (e.g., jokers) will extend this in their own types — not here.

### 2.2 Game Status

```typescript
// One-directional status progression. No backwards transitions.
export type GameStatus = "CREATED" | "IN_PROGRESS" | "COMPLETED";
```

**Change from existing code:** Removed `"PAUSED"` — the HLD and CX doc do not define a pause flow. Games either progress or complete. Disconnection is handled by auto-pass (LLD 7/8), not by pausing the game.

### 2.3 Game Type

```typescript
export type GameType = "big2" | "tonk";
```

### 2.4 Player Identity (in game context)

```typescript
// Unique identifier for a player within a game session.
// Maps to either a Supabase user ID or a guest session ID.
export type PlayerId = string;

export interface PlayerInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
}
```

### 2.5 Game Actions

```typescript
// Base type for all game actions. Each game engine defines its own
// action types that extend this with game-specific payloads.
export interface GameAction {
  readonly type: string;         // Action discriminator (e.g., "playCards", "pass")
  readonly playerId: PlayerId;   // Who is performing the action
}

// The subset of actions a player can currently perform.
// Sent to the client as part of PlayerView.
// The client uses this to enable/disable UI elements.
export interface ValidAction {
  readonly type: string;         // Action type the player may submit
  readonly description?: string; // Human-readable label (e.g., "Pass", "Play selected cards")
}

// Result of attempting to apply an action to game state.
export interface ActionResult {
  readonly success: boolean;
  readonly newState: InternalGameState | null;  // null if action was rejected
  readonly error?: string;                       // Human-readable rejection reason
}
```

**Contract:** `ActionResult.newState` is non-null if and only if `success` is true. When `success` is false, the engine guarantees no mutation occurred — the original state is unchanged.

### 2.6 Internal Game State

```typescript
// Full server-side game state. Contains ALL information.
// Never sent to clients directly — always filtered through getPlayerView/getSpectatorView.
export interface InternalGameState {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly status: GameStatus;
  readonly version: number;               // Optimistic locking — increments on every state change
  readonly players: readonly PlayerInfo[];
  readonly currentPlayerIndex: number;    // Index into players array (-1 if no current turn, e.g., CREATED or COMPLETED)
  readonly turnNumber: number;            // Monotonically increasing, starts at 1
  readonly gameSpecificState: unknown;    // Game engine casts this to its concrete type
  readonly winner: PlayerId | null;       // Set when status becomes COMPLETED
  readonly scores: readonly PlayerScore[] | null; // Set when status becomes COMPLETED
  readonly randomSeed: string;            // Seed used at initialize() (for replay/debugging — not reconstructed at applyAction time)
}

export interface PlayerScore {
  readonly playerId: PlayerId;
  readonly score: number;
  readonly breakdown?: Record<string, number>; // Optional scoring details (e.g., { cardsLeft: 5, multiplier: 2, penalty: -10 })
}
```

**Design notes:**
- `gameSpecificState` is typed as `unknown` at the interface level. Each engine defines its own concrete type (e.g., `Big2State`) and casts internally. This keeps the generic interface agnostic while allowing engines full type safety inside their implementation.
- `version` starts at 1 when the game is created and increments by exactly 1 on every successful `applyAction` call.
- `currentPlayerIndex` of -1 indicates no active turn (game not started or game over).

### 2.7 Player View

```typescript
// Filtered state sent to a specific player. Physically excludes hidden information.
export interface PlayerView {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly status: GameStatus;
  readonly version: number;
  readonly players: readonly PlayerPublicInfo[];
  readonly you: PlayerPrivateInfo;
  readonly currentPlayerIndex: number;
  readonly turnNumber: number;
  readonly validActions: readonly ValidAction[];  // Empty array if not your turn or game is over
  readonly gameSpecificPublicState: unknown;      // Public game state (e.g., last play, discard pile)
  readonly winner: PlayerId | null;
  readonly scores: readonly PlayerScore[] | null;
}

// What every player can see about every other player
export interface PlayerPublicInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly cardCount: number;        // How many cards they hold (not which cards)
  readonly isConnected: boolean;     // For showing disconnection status in UI
}

// What you can see about yourself (includes your hand)
export interface PlayerPrivateInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly hand: readonly Card[];    // Your cards — the key piece of private information
}
```

**Information hiding contract:** `PlayerView` for player A must NEVER contain:
- The specific cards in any other player's hand
- The order or contents of the deck
- Any `gameSpecificState` that reveals hidden info

The only way hidden card counts (e.g., deck size) appear is if the game explicitly puts them in `gameSpecificPublicState`.

### 2.8 Spectator View

```typescript
// Filtered state for spectators. Shows public information only — no hands.
export interface SpectatorView {
  readonly gameId: string;
  readonly gameType: GameType;
  readonly status: GameStatus;
  readonly version: number;
  readonly players: readonly PlayerPublicInfo[];
  readonly currentPlayerIndex: number;
  readonly turnNumber: number;
  readonly gameSpecificPublicState: unknown;
  readonly winner: PlayerId | null;
  readonly scores: readonly PlayerScore[] | null;
  readonly spectatorCount: number;
}
```

**Spectator view is strictly a subset of any PlayerView** minus `you` (no hand) and `validActions` (spectators cannot act).

---

## 3. GameEngine Interface

Located at `src/backend/engine/game-engine.ts`.

```typescript
import type {
  GameType,
  GameAction,
  ActionResult,
  InternalGameState,
  PlayerView,
  SpectatorView,
  PlayerId,
  PlayerInfo,
  ValidAction,
} from "@/shared/engine-types";
import type { PRNG } from "./prng";

export interface GameEngineConfig {
  readonly maxPlayers: number;
  readonly minPlayers: number;
  readonly options: Record<string, unknown>; // Game-specific options (e.g., timer duration)
}

export interface GameEngine {
  /** The game type this engine handles. */
  readonly gameType: GameType;

  /**
   * Create a new game's initial state.
   * Called once when the host clicks "Start Game" and all players are present.
   *
   * Contract:
   * - Returns state with status "IN_PROGRESS"
   * - Deck is shuffled using the provided PRNG
   * - Cards are dealt to all players
   * - currentPlayerIndex is set to the correct starting player
   * - version is 1
   * - Throws if players.length < minPlayers or > maxPlayers
   */
  initialize(
    gameId: string,
    players: readonly PlayerInfo[],
    config: GameEngineConfig,
    prng: PRNG,
  ): InternalGameState;

  /**
   * Check whether an action is valid given the current state.
   * Does NOT modify state. Used for pre-validation and UI hints.
   *
   * Contract:
   * - Returns true if applyAction would succeed with this action
   * - Returns false otherwise
   * - Must be side-effect-free (pure predicate)
   * - Must be consistent with getValidActions (if action.type is in validActions for the player, this returns true)
   */
  validateAction(state: InternalGameState, action: GameAction): boolean;

  /**
   * Apply a validated action to produce new state.
   *
   * Contract:
   * - If action is invalid: returns { success: false, newState: null, error: "reason" }
   * - If action is valid: returns { success: true, newState: <new state>, error: undefined }
   * - newState.version === state.version + 1
   * - Original state object is NEVER mutated (returns a new object)
   * - State transitions are deterministic: same (state, action) always produces same newState
   * - If the action causes a win condition, newState.status === "COMPLETED" and newState.winner is set
   *
   * Mid-game randomness (e.g., Tonk draw-from-deck):
   *   applyAction has NO PRNG parameter — it must be deterministic. Games requiring
   *   mid-game randomness must pre-shuffle the full deck at initialize() and store it
   *   as an ordered array in gameSpecificState. Drawing is then just popping from the
   *   pre-shuffled array (deterministic, no PRNG needed at action time). This keeps
   *   applyAction pure and avoids PRNG state reconstruction from persistence.
   */
  applyAction(state: InternalGameState, action: GameAction): ActionResult;

  /**
   * Derive the filtered view for a specific player.
   *
   * Contract:
   * - Output physically excludes all hidden information
   * - validActions is populated only if it is this player's turn AND status is "IN_PROGRESS"
   * - validActions is empty array otherwise (never undefined/null)
   * - Must not modify state (pure derivation)
   */
  getPlayerView(state: InternalGameState, playerId: PlayerId): PlayerView;

  /**
   * Get the list of valid actions for a specific player given current state.
   *
   * Contract:
   * - Returns empty array if it is not this player's turn
   * - Returns empty array if game status is not "IN_PROGRESS"
   * - Each ValidAction in the result represents a type of action the player may submit
   * - For games with combinatorial actions (e.g., Big2 where many card combinations are valid),
   *   this returns action TYPES (e.g., "playCards", "pass"), not every possible card combination
   */
  getValidActions(state: InternalGameState, playerId: PlayerId): readonly ValidAction[];

  /**
   * Check if the game has ended.
   *
   * Contract:
   * - Returns true if and only if state.status === "COMPLETED"
   * - Pure derivation, no side effects
   */
  isGameOver(state: InternalGameState): boolean;

  /**
   * Derive the spectator view from current state.
   *
   * Contract:
   * - Contains no player hands
   * - Contains no hidden game state (deck contents, etc.)
   * - Shows card counts, last play, turn order, game status
   */
  getSpectatorView(state: InternalGameState, spectatorCount: number): SpectatorView;
}
```

### 3.1 State Machine Conventions

All engines must follow these conventions:

1. **Named states via `status`:** `CREATED` (pre-start), `IN_PROGRESS` (playing), `COMPLETED` (game over).
2. **Turn-based progression:** `currentPlayerIndex` always identifies whose turn it is. The engine advances it after each valid action.
3. **Valid actions drive everything:** A player can only perform actions whose `type` appears in `getValidActions(state, playerId)`. The server rejects all other submissions.
4. **Deterministic transitions:** Given the same `InternalGameState` and `GameAction`, `applyAction` always produces the same `ActionResult`. No hidden state, no ambient dependencies.
5. **Immutable state:** `applyAction` returns a new state object. It never mutates the input. This enables safe caching and comparison.
6. **One-directional status:** `CREATED -> IN_PROGRESS -> COMPLETED`. Never backwards. The `initialize` method transitions from `CREATED` to `IN_PROGRESS`. Winning transitions from `IN_PROGRESS` to `COMPLETED`.

**Ownership of `CREATED` status:** The engine only operates on games with status `IN_PROGRESS` or `COMPLETED`. The `CREATED` state represents a pre-engine lobby managed by the service layer (REST handler in LLD 1 creates a Game entity with status `CREATED`, playerIds, maxPlayers — no engine involvement). When the host clicks "Start Game", the service layer calls `engine.initialize()` which produces the first `IN_PROGRESS` state. Before that point, the engine is not involved — the lobby is just a DB row with metadata.

### 3.2 Timer-Triggered Auto-Pass

The engine interface accommodates timer-triggered auto-pass (LLD 7) without special support. The timer lives outside the engine. When it fires, the orchestration layer constructs a "pass" action for the timed-out player and calls `applyAction`. The engine does not know or care that the action was timer-generated versus player-submitted.

---

## 4. PRNG Design

Located at `src/backend/engine/prng.ts`.

### 4.1 Interface

```typescript
/**
 * Pseudorandom number generator interface.
 * All game randomness flows through this — never Math.random() directly.
 */
export interface PRNG {
  /** Returns a float in [0, 1) — same contract as Math.random() */
  next(): number;

  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number;

  /** Fisher-Yates shuffle of an array (returns new array, does not mutate input) */
  shuffle<T>(array: readonly T[]): T[];

  /** The seed this PRNG was initialized with (for persistence/replay) */
  readonly seed: string;
}
```

### 4.2 Seeded Implementation

```typescript
/**
 * Seeded PRNG using a simple but adequate algorithm (mulberry32 or similar).
 * Deterministic: same seed always produces same sequence.
 */
export class SeededPRNG implements PRNG {
  readonly seed: string;
  private state: number;

  constructor(seed?: string) {
    this.seed = seed ?? generateSeed();
    this.state = hashSeed(this.seed);
  }

  next(): number { /* mulberry32 or xorshift32 */ }
  nextInt(min: number, max: number): number { /* uses this.next() */ }
  shuffle<T>(array: readonly T[]): T[] { /* Fisher-Yates using this.next() */ }
}

/** Generate a random seed string (used for production games) */
function generateSeed(): string {
  // Uses crypto.randomBytes — this is the ONLY place real randomness enters the system
}

/** Hash a seed string to a numeric state for the PRNG algorithm */
function hashSeed(seed: string): number { /* djb2 or similar string hash */ }
```

### 4.3 Test PRNG

For tests that need specific card arrangements without determinism complexity:

```typescript
/**
 * Test-only PRNG that returns values from a predefined sequence.
 * When sequence is exhausted, wraps around.
 */
export class FixedPRNG implements PRNG {
  readonly seed: string = "fixed-test";
  private values: number[];
  private index: number = 0;

  constructor(values: number[]) {
    this.values = values;
  }

  next(): number {
    const val = this.values[this.index % this.values.length];
    this.index++;
    return val;
  }

  nextInt(min: number, max: number): number { /* derives from this.next() */ }
  shuffle<T>(array: readonly T[]): T[] { /* returns input unshuffled if values empty, else Fisher-Yates */ }
}
```

**Usage in tests:**
- `new SeededPRNG("test-seed-42")` — reproducible but realistic shuffle
- `new FixedPRNG([])` with empty values — no-op shuffle (cards stay in creation order)
- `new FixedPRNG([0.1, 0.5, 0.9, ...])` — controlled sequence for specific arrangements

---

## 5. GameEngineFactory

Located at `src/backend/engine/game-engine-factory.ts`.

```typescript
import type { GameEngine } from "./game-engine";
import type { GameType } from "@/shared/engine-types";

/**
 * Maps game type identifiers to engine instances.
 * Engines are stateless (all state in InternalGameState), so a single instance per type suffices.
 */
export class GameEngineFactory {
  private readonly engines: Map<GameType, GameEngine> = new Map();

  /** Register an engine for a game type. Called at server startup. */
  register(engine: GameEngine): void {
    if (this.engines.has(engine.gameType)) {
      throw new Error(`Engine already registered for game type: ${engine.gameType}`);
    }
    this.engines.set(engine.gameType, engine);
  }

  /** Get the engine for a game type. Throws if not registered. */
  getEngine(gameType: GameType): GameEngine {
    const engine = this.engines.get(gameType);
    if (!engine) {
      throw new Error(`No engine registered for game type: ${gameType}`);
    }
    return engine;
  }

  /** Check if an engine is registered for a game type. */
  hasEngine(gameType: GameType): boolean {
    return this.engines.has(gameType);
  }

  /** List all registered game types. */
  getRegisteredTypes(): GameType[] {
    return Array.from(this.engines.keys());
  }
}
```

**Lifecycle:**
- A single `GameEngineFactory` instance is created at server startup.
- Each engine implementation is registered via `factory.register(new Big2Engine())`.
- The factory is injected into the game service/WebSocket handler as a dependency.
- Engines are singletons (stateless) — they hold no per-game data.

---

## 6. In-Memory Game Cache

Located at `src/backend/engine/game-cache.ts`.

### 6.1 Design

```typescript
import type { InternalGameState } from "@/shared/engine-types";

export interface GameCacheEntry {
  state: InternalGameState;
  lastAccessedAt: number;   // Date.now() timestamp
  isDirty: boolean;         // true if state has changed since last DB write
}

export interface GameCacheConfig {
  maxEntries: number;          // Maximum number of games in cache (default: 1000)
  evictionCheckIntervalMs: number; // How often to run eviction (default: 60000 = 1 min)
  inactivityThresholdMs: number;   // Evict after this much inactivity (default: 3600000 = 1 hour)
}

export class GameCache {
  private readonly cache: Map<string, GameCacheEntry> = new Map();
  private readonly config: GameCacheConfig;
  private evictionTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<GameCacheConfig>) {
    this.config = {
      maxEntries: config?.maxEntries ?? 1000,
      evictionCheckIntervalMs: config?.evictionCheckIntervalMs ?? 60_000,
      inactivityThresholdMs: config?.inactivityThresholdMs ?? 3_600_000,
    };
  }

  /** Get game state from cache. Returns null if not cached (caller must load from DB). */
  get(gameId: string): InternalGameState | null;

  /** Put game state into cache. Marks as clean (just loaded or just persisted). */
  set(gameId: string, state: InternalGameState): void;

  /** Update game state in cache after an action. Marks as dirty. */
  update(gameId: string, state: InternalGameState): void;

  /** Mark a game as persisted (clean). Called after successful DB write. */
  markClean(gameId: string): void;

  /** Remove a game from cache. Called on game completion + successful persist. */
  evict(gameId: string): void;

  /** Check if a game is in cache. */
  has(gameId: string): boolean;

  /** Get all dirty entries (for batch persistence). */
  getDirtyEntries(): Array<{ gameId: string; state: InternalGameState }>;

  /** Start the periodic eviction timer. Called once at server startup. */
  startEvictionLoop(): void;

  /** Stop the eviction timer. Called on server shutdown. */
  stopEvictionLoop(): void;
}
```

### 6.2 Eviction Policy

Games are evicted from cache when:

1. **Game completed:** Evicted immediately after final state is persisted to DB.
2. **Inactivity timeout:** No `get` or `update` call for `inactivityThresholdMs` (default 1 hour). The periodic eviction loop checks and removes these.
3. **Capacity overflow:** If `cache.size >= maxEntries`, evict the least-recently-accessed entry before inserting a new one.

**Eviction safety:** Before evicting a dirty entry, the orchestration layer must persist it to DB first. The cache itself does not perform I/O — it signals via `getDirtyEntries()` and the orchestration layer handles persistence.

**Persistence contract:** The cache delegates persistence to `GameRepository.saveGame(game)` defined in LLD 1 (`src/backend/database/database.ts`). The orchestration layer (GameService, defined in LLD 3) calls `gameRepo.saveGame()` after each cache update. References to `persistToDb` in the pseudocode below are shorthand for this call.

### 6.3 Cache Lifecycle

```
Player connects to game
  → GameService checks cache.get(gameId)
  → If null: load from DB, cache.set(gameId, state)
  → If found: use cached state

Player submits action
  → engine.applyAction(cachedState, action)
  → If success: cache.update(gameId, newState) → persist to DB → cache.markClean(gameId)
  → If failure: return error, cache unchanged

Game completes
  → persist final state → cache.evict(gameId)

Server shutdown
  → persist all dirty entries → cache.stopEvictionLoop()
```

### 6.4 No Distributed Cache

Per architecture principle 6 (start monolith), the cache is a simple in-process `Map`. No Redis, no shared state. If horizontal scaling is ever needed, the extraction path is documented in the HLD (Redis pub/sub pattern).

---

## 7. Concurrency Strategy

### 7.1 Problem

Multiple players may submit actions simultaneously for the same game. Without protection, two concurrent `applyAction` calls could both read version N, both produce version N+1, and the second write would silently overwrite the first.

### 7.2 Optimistic Locking via Version Field

The `version` field on `InternalGameState` serves as an optimistic lock:

1. Before applying an action, read the current state (from cache — fast).
2. Apply the action: `newState.version = state.version + 1`.
3. When writing to cache/DB, verify that the current cached version matches what we read. If it has changed (another action was applied between our read and write), reject this action.

**Implementation in the orchestration layer (GameService, not in the engine):**

```typescript
async function handleAction(gameId: string, action: GameAction): Promise<ActionResult> {
  // 1. Read from cache (sync)
  const state = gameCache.get(gameId);
  if (!state) { /* load from DB via await, then cache.set — race window here */ }

  // 2. Apply action (sync, pure — no await, no race window)
  const result = engine.applyAction(state, action);
  if (!result.success) return result;

  // 3. Update cache (sync — still no await, so no other request can interleave)
  gameCache.update(gameId, result.newState!);

  // 4. Persist to DB (async — other requests CAN run during this await,
  //    but they will read the already-updated cache, which is correct)
  await gameRepo.saveGame(toEntity(gameId, result.newState!));
  gameCache.markClean(gameId);

  return result;
}
```

**Why this ordering is safe in single-threaded Node.js:** Steps 1–3 are synchronous (no `await`), so they execute atomically within a single event loop tick. No other request can interleave. The race window only opens at step 4 (`await`), but by then the cache already holds the new state — any concurrent reader sees the correct version.

**When the optimistic lock matters:** The DB-level `WHERE version = $expected` clause (Section 7.5) guards against future multi-process scaling. In the monolith, it should never fire. If it does, it indicates a bug (not a normal race).

### 7.3 Why Optimistic (Not Pessimistic)

- Turn-based games have low contention: typically only one player acts at a time.
- The valid action check (`getValidActions`) already prevents most conflicts — only the current player has valid actions.
- Real conflicts are rare: simultaneous submissions from the same player (double-click), or timer expiry racing with a player action.
- Optimistic locking adds no latency on the happy path (no lock acquisition).
- Pessimistic locking (mutex per game) would add complexity with minimal benefit for turn-based games.

### 7.4 Conflict Resolution for the Client

When the client receives a version conflict rejection:
- The WebSocket layer sends the current state to the client (via `game:state` event).
- The client re-renders with the latest state and `validActions`.
- If it is still the player's turn, they can resubmit. If another player acted (e.g., timer auto-pass), the UI updates accordingly.

### 7.5 Database Persistence

The `version` column in the Game table enables a DB-level safety net:

```sql
UPDATE game SET state = $1, version = $2 WHERE game_id = $3 AND version = $4;
```

If `rowCount === 0`, the write failed due to a version mismatch — another server instance (if horizontal scaling is ever added) wrote first. In the single-process monolith, this case should never occur because the in-memory check catches it first.

---

## 8. File Layout

```
src/
  shared/
    engine-types.ts           -- All shared types (Card, Suit, Rank, GameAction, etc.)
                              -- Replaces/expands the placeholder types in model.ts

  backend/
    engine/
      game-engine.ts          -- GameEngine interface + GameEngineConfig
      game-engine-factory.ts  -- GameEngineFactory class
      game-cache.ts           -- GameCache class + GameCacheEntry + GameCacheConfig
      prng.ts                 -- PRNG interface + SeededPRNG + FixedPRNG + generateSeed + hashSeed

tests/
  engine/
    prng.test.ts              -- PRNG determinism, distribution, shuffle correctness
    game-cache.test.ts        -- Cache get/set/evict/dirty tracking
    game-engine-factory.test.ts -- Registration, retrieval, error cases
```

---

## 9. Migration from Existing Types

The existing `SerializableGame`, `SerializableGameState`, `GameType`, and `GameStatus` in `src/shared/model.ts` will be superseded by the types in `src/shared/engine-types.ts`.

**Migration plan:**
1. Create `src/shared/engine-types.ts` with all new types.
2. Update `GameType` and `GameStatus` in `model.ts` to re-export from `engine-types.ts` (maintains backward compatibility during transition). Any existing code referencing `"PAUSED"` status must be removed in the same commit.
3. Existing REST endpoints (`createGame`, `joinGame`, `getGameState`) will be updated in LLD 3 (WebSocket layer) to use the new types. Until then, they continue working with the old types.
4. `SerializableGame` and `SerializableGameState` are deprecated — replaced by `InternalGameState` for server-side and `PlayerView` for client-side.

---

## 10. Testing Strategy

### 10.1 PRNG Tests (`tests/engine/prng.test.ts`)

| Test | What it verifies |
|------|------------------|
| Same seed produces same sequence | `new SeededPRNG("seed").next()` called N times produces identical results across runs |
| Different seeds produce different sequences | Two PRNGs with different seeds diverge immediately |
| `nextInt` respects bounds | Result is always in [min, max] inclusive, over 1000 calls |
| `shuffle` returns all elements | Output has same length and same elements (no loss/duplication) |
| `shuffle` does not mutate input | Original array unchanged after shuffle |
| `shuffle` with same seed is deterministic | Same seed + same input = same output |
| `FixedPRNG` returns predefined values | Sequence matches constructor input |
| `FixedPRNG` wraps on exhaustion | After consuming all values, starts from index 0 |

### 10.2 GameCache Tests (`tests/engine/game-cache.test.ts`)

| Test | What it verifies |
|------|------------------|
| `get` returns null for missing game | Cache miss returns null, not error |
| `set` then `get` returns same state | Round-trip works |
| `update` marks entry dirty | `getDirtyEntries()` includes updated game |
| `markClean` clears dirty flag | After `markClean`, not in `getDirtyEntries()` |
| `evict` removes entry | `get` returns null after evict |
| Eviction on inactivity | Entry removed after threshold (use fake timers) |
| Eviction on capacity overflow | Oldest entry evicted when max reached |
| `has` returns correct boolean | true for cached games, false for others |

### 10.3 GameEngineFactory Tests (`tests/engine/game-engine-factory.test.ts`)

| Test | What it verifies |
|------|------------------|
| Register and retrieve | `getEngine` returns the registered engine |
| Duplicate registration throws | Cannot register two engines for same type |
| Missing engine throws | `getEngine` for unregistered type throws descriptive error |
| `hasEngine` correctness | Returns true/false appropriately |
| `getRegisteredTypes` lists all | Returns all registered game types |

### 10.4 GameEngine Interface Compliance (for each engine implementation)

Each engine implementation (LLD 4 for Big2) must pass these generic tests:

| Test category | What it verifies |
|---------------|------------------|
| Initialize produces valid state | Status is IN_PROGRESS, version is 1, all players present, cards dealt |
| Initialize rejects invalid player count | Throws for < minPlayers or > maxPlayers |
| applyAction increments version | newState.version === state.version + 1 |
| applyAction is immutable | Original state object unchanged after call |
| Invalid action returns success=false | Wrong player, invalid type, bad payload |
| Invalid action does not change state | ActionResult.newState is null |
| getPlayerView excludes hidden info | Player A's view never contains player B's cards |
| getPlayerView has validActions only on turn | Non-current player gets empty validActions |
| getSpectatorView has no hands | No Card arrays in spectator output |
| Game over detected correctly | isGameOver returns true iff status is COMPLETED |
| Full game simulation | Play to completion using only valid actions, assert invariants each step |
| Card conservation invariant | Total cards across all hands + public areas is constant |
| Status never goes backwards | Track status across all transitions, verify monotonic progression |

---

## 11. Edge Cases

| Edge case | Handling |
|-----------|----------|
| Action submitted for wrong game | Orchestration layer validates gameId before reaching engine |
| Action submitted by non-participant | Orchestration layer verifies playerId is in game's players array |
| Action submitted after game over | `getValidActions` returns empty; `applyAction` returns failure |
| Two actions submitted simultaneously | Optimistic locking rejects the slower one (version mismatch) |
| Timer fires same instant as player action | Race resolved by optimistic lock — one succeeds, one gets version conflict |
| Game state corrupted in cache (crash) | On cache miss, reload from DB. DB always has last persisted version |
| Server restart mid-game | All cache lost. Games reloaded from DB on next access. May lose at most one un-persisted action (acceptable for turn-based) |
| Player submits action not in validActions | `validateAction` returns false; `applyAction` returns failure with descriptive error |
| Engine initialized with 0 or 1 players | `initialize` throws (minPlayers enforcement) |
| Cache evicts dirty entry | Eviction loop calls `getDirtyEntries()` and persists before evicting |

---

## 12. Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| Node.js `crypto` module | Available | Used only in `generateSeed()` for real randomness |
| TypeScript strict mode | Configured | Existing `tsconfig.json` has strict enabled |
| `src/shared/` directory | Exists | Currently has `model.ts` and `crypto.ts` |
| `src/backend/engine/` directory | Does not exist | Must be created |
| `tests/engine/` directory | Does not exist | Must be created |

No external npm packages required. All implementations use Node.js standard library only.

---

## 13. Acceptance Criteria

Implementation is complete when:

1. All type definitions compile with zero TypeScript errors under strict mode.
2. `GameEngine` interface is importable from `src/backend/engine/game-engine.ts`.
3. `SeededPRNG` produces deterministic output given the same seed (proven by tests).
4. `FixedPRNG` returns predefined values and wraps correctly (proven by tests).
5. `GameCache` correctly stores, retrieves, dirties, cleans, and evicts entries (proven by tests).
6. `GameEngineFactory` registers, retrieves, and rejects duplicates (proven by tests).
7. All shared types are importable from `src/shared/engine-types.ts` by both frontend and backend.
8. No `Math.random()` calls exist in any engine-related file.
9. No I/O (network, filesystem, database) exists in any file under `src/backend/engine/` except `generateSeed()` which uses `crypto.randomBytes`.
10. All tests pass via `npm test`.
