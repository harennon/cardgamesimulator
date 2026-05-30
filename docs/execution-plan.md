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
  └── LLD 6: Frontend Game UI (depends on: WebSocket Layer, Big2 Engine, Guest Access)

Phase 4: Online Features
  ├── LLD 7: Turn Timer + Stats (depends on: Big2 Engine)
  └── LLD 8: Spectating + Reconnection (depends on: WebSocket Layer)

Phase 5: Polish
  └── (No LLD — driven by CX doc and playtesting)

Phase 6: Deployment
  └── LLD 9: Deployment (independent — can start anytime after Phase 1)
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
- Straights: A can be low (A-2-3-4-5) or high (10-J-Q-K-A), no wrapping, 2 never in a straight
- No flushes, no triples
- 2–4 player support (deck adjustment: 3P removes 1 card for 17 each; 2P removes 26 cards for 13 each — exact removal scheme TBD in LLD)
- Game flow (first play must include lowest card, trick reset on all pass, win on empty hand)
- Scoring (penalty per remaining card with multipliers)
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

## Phase 4: Online Features

Features that make it a full multiplayer experience.

### LLD 7: Turn Timer + Stats

**Scope:** Server-side turn timer and persistent player statistics.

- Timer: in-memory countdown per active game, starts on turn begin, auto-pass on expiry
- Timer configuration: set at game creation (off / 30s / 60s / 90s)
- Timer broadcast: include remaining time in `PlayerView` state updates
- PlayerStats entity: games played, won, lost, total score, last played timestamp
- Stats update trigger: on game completion, update all players' stats
- Guest-to-registered conversion: apply pending game result to new account
- Home dashboard: display stats and recent game history

**Depends on:** LLD 4 (Big2 engine must exist for timer to auto-pass)
**Outputs:** Timer visible in UI, stats tracked and displayed

---

### LLD 8: Spectating + Reconnection

**Scope:** Non-player viewing and robust connection handling.

- Spectator WebSocket role: join room as viewer, receive SpectatorView only
- Spectator entry: arrive at in-progress game → offered spectator mode
- Spectator count broadcast to players ("2 watching")
- Reconnection: on WebSocket reconnect, server sends full current state
- Disconnect handling: short grace period (30s), then auto-pass per turn until reconnect or game end
- Mid-game player departure: if a player leaves permanently, auto-pass their turns for remainder of game

**Depends on:** LLD 3 (WebSocket layer)
**Outputs:** Spectating works, disconnects handled gracefully

---

## Phase 5: Polish

No LLD — driven by playtesting and the CX doc. Work includes:

- Card animations (deal, draw, play transitions)
- Game log panel (recent actions in sidebar)
- Mobile-responsive layout
- Invite UX (copy link button, native share on mobile)
- Rematch flow (same players, new game with one click)
- Toast notifications (player joined, timer warning, connection status)
- Loading/transition states
- Sound effects (optional)

A `docs/ux-polish.md` can be written when this phase begins.

---

## Phase 6: Deployment

### LLD 9: Deployment

**Scope:** Get the app running online.

- Environment configuration (Supabase cloud project, env vars for production)
- Docker setup for production (Express server, no local Supabase)
- TLS/HTTPS (reverse proxy or PaaS-managed)
- Domain setup
- CI/CD (optional: GitHub Actions for build + deploy on push)
- Monitoring basics (health check endpoint, error logging)

**Depends on:** Phase 1 (foundation must be stable)
**Can start:** Anytime after Phase 1. Can run in parallel with Phases 2–5.
**Outputs:** App accessible at a public URL

---

## Summary

| Phase | LLDs | Key Milestone |
|-------|------|---------------|
| 1. Foundation | 1, 2, 3 | Auth, DB, WebSocket, engine interface — infrastructure ready |
| 2. Core Game | 4, 5 | Big2 playable via WebSocket, guests can join |
| 3. Frontend | 6 | Big2 playable in browser |
| 4. Online Features | 7, 8 | Timer, stats, spectating, reconnection |
| 5. Polish | — | Animations, mobile, UX improvements |
| 6. Deployment | 9 | Live online |

**Total: 9 LLDs, 6 phases.** Each LLD is written just before implementation (not all upfront). Phases are sequential but deployment can be pulled forward once Phase 1 is done.
