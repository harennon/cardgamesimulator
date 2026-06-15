# Execution Plan

Ordered work breakdown with dependencies. Each item produces a low-level design doc (LLD) followed by implementation.

---

## Dependency Graph

```
Phase 1: Foundation
  ├── LLD 1: Supabase Migration
  ├── LLD 2: Game Engine Interface
  └── LLD 3: WebSocket Layer (depends on: Supabase auth for JWT verification)

Phase 2: Core Game
  ├── LLD 4: Big2 Rules + Engine (depends on: Game Engine Interface)
  └── LLD 5: Guest Access (depends on: Supabase Migration for auth model)

Phase 3: Frontend
  ├── LLD 6: Frontend Game UI (depends on: WebSocket Layer, Big2 Engine, Guest Access)
  └── LLD 6.5: Integration Test Suite (depends on: all of Phase 1-3)

Phase 4: Online Features
  ├── LLD 7a: Turn Timer (depends on: Big2 Engine)
  ├── LLD 7b: Player Stats (depends on: Big2 Engine, Turn Timer)
  ├── LLD 8a: Spectating (depends on: WebSocket Layer)
  └── LLD 8b: Reconnection + Disconnect Handling (depends on: WebSocket Layer, Turn Timer)

Phase 5A: Playtest Readiness
  ├── LLD 9: Feedback Widget (depends on: Frontend Game UI)
  └── LLD 10: Deployment (independent — can start anytime after Phase 1)

Phase 5B: Polish
  ├── LLD 11: Mobile Layout (depends on: Frontend Game UI)
  ├── LLD 12: Rematch + Invite UX (depends on: WebSocket Layer)
  └── LLD 13: Animations + Polish (depends on: Frontend Game UI)
```

---

## Phase 1: Foundation

The infrastructure work. After this phase, we have auth, database, real-time communication, and the engine contract — ready for game logic.

### LLD 1: Supabase Migration

**Scope:** Replace custom auth + local Postgres with Supabase (local + cloud).

- Delete custom auth code (nonce flow, argon2, JWT signing, auth endpoints, crypto.ts)
- Integrate Supabase JS SDK (frontend: `signUp`, `signInWithPassword`, `getSession`)
- Backend JWT verification middleware (verify Supabase-issued JWTs)
- Database schema in Supabase (Game, PlayerStats tables via TypeORM migrations)
- Local dev setup (`supabase init`, `supabase start`, seed scripts)
- Environment config (.env.local vs .env.production)

**Depends on:** Nothing (first item)
**Outputs:** Working auth flow, DB connected, local Supabase running

---

### LLD 2: Game Engine Interface

**Scope:** Define the TypeScript interface contract that all game engines implement.

- `GameEngine` interface (initialize, validateAction, applyAction, getPlayerView, getValidActions, isGameOver)
- Shared types: Card, Suit, Rank, GameAction, ActionResult, InternalGameState, PlayerView, SpectatorView
- State machine conventions (states declare valid actions, transitions are deterministic)
- Injectable randomness (PRNG interface, seeded implementation)
- GameEngineFactory (maps gameType → engine instance)
- In-memory game cache design (Map<gameId, state>, eviction policy)
- Concurrency strategy (optimistic locking via version column)

**Depends on:** Nothing (can parallel with LLD 1)
**Outputs:** Interface files in `src/shared/`, engine utilities in `src/backend/engine/`

---

### LLD 3: WebSocket Layer

**Scope:** Replace SSE with Socket.IO for bidirectional game communication.

- Socket.IO server setup (attach to Express HTTP server)
- Auth middleware on connection (verify Supabase JWT from handshake)
- Room management (join room by gameId, leave on disconnect)
- Event protocol: `game:action` (client → server), `game:state` (server → client per player)
- Guest connection handling (guest tokens vs authenticated JWTs)
- Reconnection flow (rejoin room, receive current state)
- Remove old SSE infrastructure (event.ts, EventSourceSingleton, GameSubscriber SSE logic)

**Depends on:** LLD 1 (needs Supabase JWT to verify)
**Outputs:** Working WebSocket with auth, rooms, and event protocol

---

## Phase 2: Core Game

The game logic and guest access. After this phase, Big2 is playable via WebSocket (no UI).

### LLD 4: Big2 Rules + Engine

**Scope:** Complete Big2 implementation against the GameEngine interface.

- Card ranking (3 lowest → 2 highest, suits: ♣ < ♦ < ♥ < ♠)
- Combination detection and ranking (single, pair, 5-card hands: straight, full house, quad+kicker, straight flush)
- Straights: A is high only (10-J-Q-K-A is the highest, 3-4-5-6-7 is the lowest). 2 never participates in straights. No wrapping.
- No flushes, no triples
- 2–4 player support (deck adjustment: 3P removes 1 card for 17 each; 2P removes 26 cards for 13 each — exact removal scheme TBD in LLD)
- Game flow (first play must include lowest card, trick reset on all pass, play continues until last place)
- Scoring (placement-based: 5/3/1/0 points by finishing order)
- `getPlayerView()` implementation (hide other players' hands)
- `getValidActions()` implementation (which combos from hand can beat current play)
- Test suite: combination ranking, validation, full game simulation, invariant checks

**Depends on:** LLD 2 (implements GameEngine interface)
**Outputs:** `Big2Engine` class, fully unit-tested

---

### LLD 5: Guest Access

**Scope:** Enable unauthenticated users to join and play games.

- Guest identity model (temporary session token, display name, no Supabase account)
- Guest session persistence (cookie-based, survives page refresh within same game)
- Backend: accept guest tokens alongside Supabase JWTs in WebSocket auth and REST endpoints
- Guest entry screen (display name prompt on invite link arrival)
- Guest-to-registered conversion flow (sign up after game, retroactive stat assignment)
- Guest limitations (cannot create games, no persistent stats)
- Cleanup: guest sessions expire after game completes or inactivity timeout

**Depends on:** LLD 1 (needs to know the auth model to extend it for guests)
**Outputs:** Guest can join and play via invite link without signing up

---

## Phase 3: Frontend

The game UI. After this phase, Big2 is playable in the browser.

### LLD 6: Frontend Game UI

**Scope:** Build the game screens from the CX doc wireframes.

- Socket.IO client composable (`useSocket.ts` — connect, auth, event listeners)
- Game state composable (`useGameState.ts` — reactive state from `game:state` events)
- Game actions composable (`useGameActions.ts` — emit actions via WebSocket)
- Card selection composable (`useCardSelection.ts` — multi-select, valid combo detection for UX)
- Card component (CSS-based rendering, face/back, selected state)
- Hand component (fan layout, click to select)
- Game board layout (opponents top, center play area, player hand bottom)
- Action panel (Play/Pass buttons, enabled based on `validActions`)
- Game lobby updates (wire start button, guest names, WebSocket-based player list)
- Game over screen (scores, rematch, guest sign-up nudge)
- Route flow: lobby → board → game over based on game status

**Depends on:** LLD 3 (WebSocket), LLD 4 (Big2 engine for valid action UX), LLD 5 (guest entry screen)
**Outputs:** Full playable Big2 in browser, matching CX wireframes

---

### LLD 6.5: Integration Test Suite

**Scope:** Backend integration tests that verify cross-layer behavior against real Supabase.

- Vitest + supertest + socket.io-client test infrastructure
- Docker Compose test environment (backend + Supabase, no frontend)
- Test helpers: Supabase user creation, JWT retrieval, authenticated socket connections
- Critical flow tests: auth (ES256 JWT), game CRUD, WebSocket game play, guest flow
- GitHub Actions workflow (boots Supabase, runs integration tests)
- Convention for Phase 4+ LLDs to add integration tests

**Depends on:** All of Phase 1-3 (needs working auth, engine, WebSocket, and guest access)
**Outputs:** ~13 integration tests catching cross-layer bugs, CI pipeline running them on every PR

---

## Phase 4: Online Features

Features that make it a full multiplayer experience.

### LLD 7a: Turn Timer

**Scope:** Server-side turn timer with auto-play on expiry.

- Timer: in-memory countdown per active game, starts on turn begin, auto-pass on expiry
- Timer configuration: set at game creation (off / 30s / 60s / 90s)
- Timer broadcast: include `turnDeadline` (absolute timestamp) in PlayerView via socket enrichment
- Injectable TimerProvider interface (RealTimerProvider for production, FakeTimerProvider for tests)
- TurnTimerService: register/start/cancel per game, 2x duration for first turn
- `getAutoTimeoutAction` on GameEngine interface (returns valid action for timed-out player)

**Depends on:** LLD 4 (Big2 engine must exist for timer to auto-pass)
**Outputs:** Timer visible in UI, auto-play on expiry

---

### LLD 7b: Player Stats

**Scope:** Persistent player statistics recorded on game completion.

- PlayerStats entity: games played, won, lost, total score, last played timestamp
- Atomic `incrementStats` via SQL `ON CONFLICT DO UPDATE SET col = col + $n`
- StatsService: fire-and-forget recording on game completion, guest filtering
- `GET /stats` endpoint: returns stats + computed winRate for authenticated user
- Stats recorded when game transitions to COMPLETED (covers both player action and timer auto-play)

**Depends on:** LLD 4 (Big2 engine), LLD 7a (timer auto-play triggers completion)
**Outputs:** Stats tracked and queryable via REST

---

### LLD 8a: Spectating

**Scope:** Non-player viewing of in-progress games.

- Spectator WebSocket role: join room as viewer, receive SpectatorView only
- Spectator entry: arrive at in-progress game → offered spectator mode
- Spectator count broadcast to players ("2 watching")
- Spectator room management (separate from player rooms, no action permissions)
- Spectator receives turnDeadline enrichment (consistent with players)

**Depends on:** LLD 3 (WebSocket layer)
**Outputs:** Spectators can watch live games without participating

---

### LLD 8b: Reconnection + Disconnect Handling

**Scope:** Robust connection handling for players who drop or leave.

- Reconnection: on WebSocket reconnect, server sends full current state
- Disconnect detection: track connected/disconnected status per player via ConnectionManager
- Grace period: short window (30s) before treating disconnect as abandonment
- Auto-pass on disconnect: if it's a disconnected player's turn and grace period expires, auto-pass using timer infrastructure
- Mid-game permanent departure: auto-pass their turns for remainder of game
- Connection status broadcast: other players see who is connected/disconnected

**Depends on:** LLD 3 (WebSocket layer), LLD 7a (reuses timer/auto-play infrastructure for disconnect auto-pass)
**Outputs:** Disconnects handled gracefully, reconnecting players rejoin seamlessly

---

## Phase 5A: Playtest Readiness

Get the app into real users' hands with a feedback loop.

---

### LLD 9: Feedback Widget

**Scope:** In-app feedback mechanism for playtesters.

- Floating "Feedback" button (always visible during gameplay)
- Modal with: category dropdown (Bug / Confusing UX / Feature Request / Other), free-text description
- Auto-captures: current route, game status, user type (guest/registered), browser/viewport
- `POST /feedback` endpoint stores submissions in Supabase `feedback` table
- No admin UI for v1 — query Supabase dashboard directly to read feedback

**Depends on:** LLD 6 (Frontend Game UI)
**Outputs:** Playtesters can submit structured feedback from within the app

---

### LLD 10: Deployment

**Scope:** Get the app running online.

- Environment configuration (Supabase cloud project, env vars for production)
- Docker setup for production (Express server, no local Supabase)
- TLS/HTTPS (reverse proxy or PaaS-managed)
- Domain setup
- CI/CD (optional: GitHub Actions for build + deploy on push)
- Monitoring basics (health check endpoint, error logging)

**Depends on:** Phase 1 (foundation must be stable)
**Can start:** Anytime after Phase 1. Can run in parallel with Phases 2–5A.
**Outputs:** App accessible at a public URL

---

## Phase 5B: Polish

Driven by playtesting feedback. Order determined by what playtesters report as most impactful.

### LLD 11: Mobile Layout

**Scope:** Responsive game board for mobile devices.

- Touch-friendly card selection and actions
- Viewport handling (safe areas, orientation)
- Responsive breakpoints for game board, lobby, and stats screens

**Depends on:** LLD 6 (Frontend Game UI)
**Outputs:** Playable on mobile browsers

---

### LLD 12: Rematch + Invite UX

**Scope:** Streamline multi-game sessions and player invitations.

- Rematch flow: same players, new game with one click from game-over screen
- Copy link button for game invites
- Native share on mobile (Web Share API)

**Depends on:** LLD 3 (WebSocket layer)
**Outputs:** Frictionless replay and sharing

---

### LLD 13: Animations + Polish

**Scope:** Visual feedback and UI delight.

- Card animations (deal, play transitions)
- Toast notifications (player joined, timer warning, connection status)
- Loading/transition states between screens
- Game log panel (recent actions in sidebar)
- Sound effects (optional)

**Depends on:** LLD 6 (Frontend Game UI)
**Outputs:** Polished, responsive game feel

---

## Summary

| Phase                  | LLDs           | Key Milestone                                              |
| ---------------------- | -------------- | ---------------------------------------------------------- |
| 1. Foundation          | 1, 2, 3        | Auth, DB, WebSocket, engine interface — infrastructure ready |
| 2. Core Game           | 4, 5           | Big2 playable via WebSocket, guests can join               |
| 3. Frontend            | 6, 6.5–6.8    | Big2 playable in browser + test safety net                 |
| 4. Online Features     | 7a, 7b, 8a, 8b | Timer, stats, spectating, reconnection                     |
| 5A. Playtest Readiness | 9, 10          | Feedback widget, deployment — live app                     |
| 5B. Polish             | 11, 12, 13     | Mobile, rematch, animations — driven by playtester feedback |

**Total: 16 LLDs, 6 phases.** Each LLD is written just before implementation (not all upfront). Phase 4 completes the full multiplayer experience. Phase 5A ships the app live with a feedback loop. Phase 5B is prioritized by playtest feedback.
