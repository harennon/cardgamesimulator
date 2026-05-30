# Architecture Principles — Browser-Based Multiplayer Card Games

Stateless guidance for architectural decisions. Derived from research into Terraforming Mars, Board Game Arena, Lichess, Hanabi Live, and other successful browser-based multiplayer games.

---

## 1. Server-Authoritative State

**Principle:** All game logic runs exclusively on the server. Clients are thin renderers.

- The server computes valid actions, applies state transitions, and determines win conditions.
- Clients receive a filtered view of state and a list of valid actions. They render choices and send selections back.
- Never trust client-submitted data beyond "which option did the player choose from the valid set."
- Never compute game rules in frontend code — not even for UI responsiveness. If you need instant feedback, validate against the `validActions` array the server already sent.

**Why:** Every successful multiplayer game studied enforces this. It eliminates entire classes of cheating and desync bugs. BGA, Lichess, Terraforming Mars, and Hanabi Live all follow this without exception.

---

## 2. Information Hiding Over Trust

**Principle:** Never send hidden information to a client, even if you "trust" them not to look.

- A player's WebSocket/HTTP response must never contain another player's hand, regardless of UI rendering.
- Design the serialization layer so it's physically impossible for a client to see data they shouldn't — not hidden by CSS, but absent from the payload entirely.
- The server maintains full internal state. Each player receives a derived view filtered to only what they're allowed to know.

**Why:** BGA explicitly prevents information leakage via `_private` key scoping. Terraforming Mars filters via `PlayerInput` objects. Network inspection tools make client-side hiding trivial to bypass.

---

## 3. Explicit State Machine

**Principle:** Model game flow as named states with declared transitions, not a generic state blob.

- Each state declares: whose turn it is, what actions are valid, what the next state is after each action.
- Use a `validActions` array in every state response. The client can only submit actions from this list. The server rejects anything else.
- State transitions should be deterministic given the same (state, action) input.

**Why:** BGA's state machine pattern (`states.inc.php`) enables hosting 500+ games through standardization. It makes engines testable (given state X and action Y, assert state Z) and prevents invalid state transitions by construction.

---

## 4. Pure Game Engine

**Principle:** The game engine has no I/O, no network awareness, no database access. It takes state + action and returns new state.

- Engine functions are pure: `(state, action) → newState`
- The engine doesn't know if it's being called from a WebSocket handler, HTTP endpoint, test harness, or CLI.
- Persistence, transport, and auth are separate layers that wrap the engine.

**Why:** This makes engines trivially unit-testable, reusable across transport layers, and independently swappable. Terraforming Mars, Lichess, and BGA all isolate game logic from infrastructure. It also means you can change your transport layer (WebSocket → polling, or vice versa) without touching game code.

---

## 5. In-Memory Cache for Active Games

**Principle:** Keep active games in memory. Persist to the database on state changes, but read from cache during gameplay.

- Don't hit the database on every action during an active game.
- Load game state from DB into memory when a player connects. Write back after each action (or batch writes).
- Evict games from cache after completion or inactivity timeout.
- The database is for durability and recovery, not for hot-path reads during play.

**Why:** Terraforming Mars keeps games in an in-memory `GameLoader` cache (15-day retention). This reduces DB load (important for free tiers) and eliminates latency from DB round-trips on the hot path.

---

## 6. Start Monolith, Extract Later

**Principle:** Run everything in a single process until you can't. The first scaling step is extracting the WebSocket layer.

- A single server comfortably handles thousands of concurrent WebSocket connections for turn-based games.
- Don't build microservices, message queues, or service meshes until you have a scaling problem.
- When (if) you need horizontal scaling, the proven extraction path is: separate the WebSocket server from game logic, connect via Redis pub/sub (Lichess pattern).
- The pure engine design (principle 4) makes this extraction non-breaking.

**Why:** Terraforming Mars runs as a single process restarted daily. Hanabi Live runs as a single Go binary. These serve thousands of players. Lichess only needed to extract services after reaching millions of concurrent users.

---

## 7. Pluggable Storage

**Principle:** Abstract database access behind an interface so the storage backend can change without affecting game logic.

- Use a repository/interface pattern between the engine and the database.
- This enables: SQLite for tests, Postgres for production, in-memory for unit tests.
- Don't couple game logic to ORM-specific features or query syntax.

**Why:** Terraforming Mars supports PostgreSQL, SQLite, and LocalFilesystem through a common interface. This provides flexibility for local dev (simple) vs. production (managed) without code changes.

---

## 8. Server-Side Randomization Only

**Principle:** All randomness (shuffle, draw, dice) must originate server-side.

- Never use client-side `Math.random()` for any game-affecting decision.
- Seeds or random values should come from the server.
- For reproducibility/replay, consider storing the random seed per game.

**Why:** BGA explicitly enforces `bga_rand()` for all randomization. Client-side randomness is trivially manipulable and causes desync between players.

---

## 9. Stateless Transport, Stateful Rooms

**Principle:** Keep the transport layer (WebSocket/HTTP) as thin as possible. It routes messages and manages connections. It doesn't interpret game state.

- The WebSocket layer manages: connection auth, room membership (who's in which game), and message routing.
- It does NOT manage: game rules, valid actions, state transitions, or scoring.
- A "room" is just a broadcast group — list of connections associated with a game ID.

**Why:** This separation means you can swap transport protocols, add spectator connections, or add admin tools without touching game logic. It's the common pattern across all studied projects.

---

## 10. Deploy Cheap, Scale When Proven

**Principle:** Optimize for low cost first. A $5/month server is the right starting point.

- Don't pay for managed services you don't need yet (Redis, load balancers, container orchestration).
- Free tiers (Supabase, Neon, Fly.io) are appropriate for games with < 500 daily active players.
- The first investment should be in game quality, not infrastructure.
- Scaling problems are a sign of success — solve them when they arrive, not before.

**Why:** Every studied project (except Lichess at its current scale) started on minimal infrastructure. Terraforming Mars recommends a single Heroku dyno. The game has to be fun before it needs to scale.

---

## Decision Heuristics

When facing an architectural choice, apply in this order:

1. **Does it add cost?** If yes, can we defer it until we need it?
2. **Does it compromise security?** Server-authoritative, information-hidden, server-randomized?
3. **Does it prevent future scaling?** Is the engine pure? Is the transport layer thin? Can we extract services later?

If a decision passes all three, it's probably correct. If it fails #1 but helps #2 or #3, verify it's actually needed at current scale before adopting.
