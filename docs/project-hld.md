# Card Game Simulator — High-Level Design Doc

## Vision

A multiplayer card game platform where friends can play preset card games together online. Big2 is the first game. The architecture supports adding more games (Tonk, eventually custom games) without rearchitecting.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│                   Browser (Vue 3 SPA)                    │
│                                                          │
│   Auth ←→ Supabase     Game Play ←→ Express/Socket.IO   │
└──────────────────────────────────────────────────────────┘
                │                          │
                ▼                          ▼
┌──────────────────┐        ┌──────────────────────────┐
│     Supabase     │        │      Express Server      │
│   • Auth         │        │   • Game CRUD (REST)     │
│   • Postgres DB  │◄───────│   • WebSocket (play)     │
│                  │        │   • Game Engine (logic)   │
└──────────────────┘        └──────────────────────────┘
```

**Separation of concerns:**
- **Supabase** owns identity and persistence — auth, database, user management
- **Express server** owns game logic and real-time communication — engine, WebSocket, game state management
- **Vue SPA** owns presentation — rendering choices the server provides, sending player selections back

**Server-authoritative:** All game logic runs exclusively on the server. The client is a thin renderer — it receives a filtered view of state and a list of valid actions, displays them, and sends the player's selection back. The client never computes game rules, validates moves, or generates randomness.

---

## Tool Choices

| Concern | Tool | Why |
|---------|------|-----|
| Auth | Supabase Auth | Free 50k MAU, eliminates custom auth code, JWT-based |
| Database | Supabase Postgres | Free 500MB, managed, standard Postgres wire protocol |
| ORM | TypeORM | Already in place, works with any Postgres host |
| Backend | Express 5 | Already in place, lightweight, good Socket.IO integration |
| Real-time | Socket.IO (WebSocket) | Bidirectional, room-based broadcast, reconnection built-in |
| Frontend | Vue 3 + Vite | Already in place, reactive, good composition API for game state |
| Containerization | Docker Compose | Local dev parity, easy deployment to any VPS |

---

## Communication Model

| Concern | Transport | Direction |
|---------|-----------|-----------|
| Auth (login, signup) | Supabase SDK (HTTPS) | Browser ↔ Supabase |
| Game management (create, join) | HTTP REST | Browser → Express |
| Game play (actions, state) | WebSocket | Browser ↔ Express |

Auth happens entirely between the browser and Supabase — the Express server only verifies the JWT on incoming requests/connections.

---

## Game Engine Model

Each game type is a self-contained engine implementing a common interface. Engines are pure functions — no I/O, no network, no database. They take state + action and return new state.

```
GameEngine (interface)
  ├── Big2Engine
  ├── TonkEngine (future)
  └── (more games)
```

**Core properties:**
- **Pure:** `(state, action) → newState`. No side effects. Trivially unit-testable.
- **State machine:** Each state declares whose turn it is, what actions are valid, and what the next state is after each action. The `validActions` array is the single source of truth for what a player can do.
- **Information hiding:** The engine maintains full internal state (all hands, deck, etc.) but exposes a `getPlayerView()` function that filters to only what a given player is allowed to see. Hidden information is *absent from the payload*, not hidden in UI.
- **Controlled randomness:** All randomness (shuffle, draw) flows through an injectable source (seeded PRNG). Tests can make it deterministic. `Math.random()` is never called directly.

Adding a new game requires only a new engine class and a game-specific action panel — no changes to WebSocket layer, database schema, or frontend framework.

## State Management

```
InternalGameState (server-only, full truth)
  → persisted to Supabase Postgres as JSON
  → cached in-memory for active games (Map<gameId, state>)
  → contains ALL cards: every hand, deck, discard pile

PlayerView (per-player, filtered)
  → derived by engine.getPlayerView(internalState, playerId)
  → contains: your hand, public piles, opponent card counts, validActions
  → physically excludes hidden information (not just UI-hidden)
  → sent to each player via WebSocket

SpectatorView (public only)
  → last play, card counts, turn order, game status
  → no player hands
```

**In-memory cache:** Active games are held in memory on the server. The database is written on state changes for durability but not read during hot-path gameplay. Games are evicted from cache after completion or inactivity. This minimizes DB load (important for free tier limits) and eliminates per-action DB round-trip latency.

---

## Local vs Deployment

| Mode | Auth + DB | Express Server | Frontend |
|------|-----------|----------------|----------|
| **Local dev** | Supabase local stack (Docker via `supabase start`) | Express + Socket.IO (local) | Vite dev server |
| **Production** | Supabase cloud (free tier) | Express + Socket.IO (VPS/PaaS) | Built SPA (served by same server or CDN) |

**Isolation principle:** Local dev never touches production Supabase. Same SDK, same API surface, different env vars (`SUPABASE_URL` points to `localhost` in dev, cloud URL in prod).

**Local dev experience:**
- `supabase start` — spins up Postgres + Auth + Studio locally in Docker
- Express server connects to local Supabase via env vars
- Can freely create/destroy test data, reset DB, iterate on schema
- Works fully offline (no internet required)

**Deployment:** Only the Express server needs hosting (VPS or PaaS with WebSocket support). Supabase cloud handles auth + DB with zero infrastructure management.

**Scaling path:** Start as a single-process monolith. A single server handles thousands of concurrent WebSocket connections for turn-based games. If horizontal scaling is ever needed, the proven extraction path is: separate WebSocket handling into a dedicated service connected via Redis pub/sub (Lichess pattern). The pure engine design makes this extraction non-breaking.

---

## Implementation Phases

| Phase | Scope | Outcome |
|-------|-------|---------|
| **1. Foundation** | Migrate auth/DB to Supabase, set up Socket.IO, implement game engine interface | Backend ready for game logic, no more custom auth |
| **2. Core Game** | Implement Big2 rules + engine, guest access | Playable Big2 via WebSocket, guests can join |
| **3. Frontend** | Card rendering, board layout, action panel, turn flow | Playable Big2 in the browser |
| **4. Online Features** | Spectating, turn timer, player stats, reconnection | Full-featured multiplayer experience |
| **5. Polish** | Animations, mobile layout, game log, rematch, invite UX | Fun and smooth to play |
| **6. Deployment** | Environment config, TLS, hosting | App live online |

Future: **Tonk** (second game engine + UI, validates extensibility).

See `docs/execution-plan.md` for the full dependency graph and LLD breakdown.

---

## Customer Experience (Brief)

- **Join a game:** Receive invite link → pick a display name (no signup required) → land in game lobby
- **Play:** See your cards, see opponent card counts, take actions on your turn, watch state update in real-time
- **Spectate:** Join a game as viewer, see all public info (plays, card counts) but no hands
- **Post-game:** See scores, rematch with same group. Register to save stats.

See `docs/customer-experience.md` for full flows, wireframes, and edge cases.

---

## Design Decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| **Scoring persistence** | Yes — track stats | Wins, losses, scoring history per player. Enables profiles/leaderboards. |
| **Game discovery** | Invite link/code only | No public lobby. Players share a game ID or link with friends. |
| **Spectating** | Yes | Spectators join as viewers. Receive SpectatorView (public info only, no hands). |
| **Turn timer** | Yes, configurable | Game creator sets timer. Server auto-passes on timeout. Timer lives in-memory (resets on server restart). |

## Quality Model

The pure engine design enables a lightweight but effective testing strategy:

- **Engine tests are fast and isolated** — no server, no DB, no network. Pure `(state, action) → newState` assertions.
- **Randomness is injectable** — seeded PRNG for reproducible integration tests, disabled shuffle for targeted unit tests.
- **Full game simulations** — at least one test plays a complete game start-to-finish, asserting invariants at every step (total cards constant, no deadlocks, valid winner).
- **Invalid action coverage** — every action type has explicit rejection tests (wrong turn, illegal play, game over).
- **Information leakage tests** — assert that `getPlayerView()` for player A never contains player B's hand.

See `docs/testing-principles.md` for full guidance.

---

## Low-Level Design Docs

See `docs/execution-plan.md` for the full execution plan with dependency graph, phasing, and ordering.

| # | Doc | Phase |
|---|-----|-------|
| 1 | Supabase Migration | Foundation |
| 2 | Game Engine Interface | Foundation |
| 3 | WebSocket Layer | Foundation |
| 4 | Big2 Rules + Engine | Core Game |
| 5 | Guest Access | Core Game |
| 6 | Frontend Game UI | Frontend |
| 7 | Turn Timer + Stats | Online Features |
| 8 | Spectating + Reconnection | Online Features |
| 9 | Deployment | Deployment |
