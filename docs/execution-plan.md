# Execution Plan

Ordered work breakdown with dependencies. Each item produces a low-level design doc (LLD) followed by implementation.

> **This plan is maintained as work ships.** The original phases (1–5B) below are the
> beginning-of-project roadmap and have been **delivered** — see **Current Status** for what
> is actually shipped vs. pending. The phase sections are retained as a design record and
> annotated with delivery status; they are no longer the active frontier. New work tracked
> since launch lives in **Phase 6** and is driven by GitHub issues, not pre-planned phases.

---

## Current Status (reconciled 2026-06-28)

The app is **live on Railway** (auto-deploy on merge to `main`) against a cloud Supabase
project. Big2 is fully playable end-to-end. The original Phase 1–5A roadmap is complete; the
Supabase + Socket.IO migration that was "planned" in the original tech notes has shipped.

### Shipped (merged to `main`)

| Area | LLDs / work | Status |
|------|-------------|--------|
| Foundation | LLD 1 Supabase migration, LLD 2 engine interface, LLD 3 WebSocket layer | Shipped |
| Core game | LLD 4 Big2 engine, LLD 5 guest access | Shipped |
| Frontend | LLD 6 game UI, 6.5 integration tests, 6.6 E2E infra, 6.7 frontend flows, 6.8 guest tests | Shipped |
| Online features | LLD 7a turn timer, 7b player stats, 8a spectating, 8b reconnection | Shipped |
| Playtest readiness | LLD 9 feedback widget, LLD 10 deployment (Railway + nginx) | Shipped |
| SDK migration | LLD 12 (TypeORM → Supabase JS SDK + RLS), LLD 13 (Railway sleep-on-idle) | Shipped |
| Polish / UX / mobile | LLD 11 mobile layout, 14 visible timer, 27/35/36/39/42 card-selection animation, 28/36 mobile invite code, 32/38 mobile non-game screens, 40/44 admin feedback delete + button centering, 43 game-over delay, 48 in-game room code, 52 auto-deselect on pass, 55 previous played cards, 58 signed-in home centering, 60 join-game mobile scroll | Shipped |
| Tonk groundwork | LLD 65 Tonk rules spec (gate cleared, signed off), LLD 69 Tonk engine (#57) | Shipped |
| Game-specific stats | LLD 66 (`player_stats` keyed per `(user_id, game_type)`) + migration `006` prod PK repair | Shipped (PR #81) |

### Live frontier — Tonk productization (Phase 6)

Tonk's rules (LLD 65) and pure engine (LLD 69) are merged. Making Tonk a selectable,
playable game end-to-end is the active work, tracked as the **Tonk consumer chain**:

- **#58** Tonk board rendering (read-only: hand, discard pile, stock, tallies) — `blocked:frontend-decision` (needs mockup)
- **#59** Tonk player-actions UI (discard, draw, TONK declaration) — `blocked:frontend-decision` (needs mockup)
- **#60** Tonk game-flow integration (type selection, lobby, `deckRoundsTarget` creator config, loss-centric stats) — ships a **new `games`-table migration** (the `deckRoundsTarget` column) against prod

### New infrastructure work (this section is the active change)

- **Migration safety + automation** (Architect-owned LLD, re-scoped — see Phase 6). Tiered:
  a **prerequisite tier** (drift detection + scripted post-apply verification + prod-shaped
  test fixture) that is a **hard blocker before the first `games`-table migration in #60**,
  and a **scheduled tier** (full automated `supabase db push` in the deploy path) that lands
  later.
- **#83** Clean up prod schema drift (TypeORM-era `*_pkey1` constraint names on `games` /
  `feedback`, stray `anon` write grants). **Sequenced first** — a clean prod baseline makes
  the drift-detection gate's "expected diff" tractable.

---

## Dependency Graph (original roadmap — delivered)

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

Phase 6: Tonk Productization + Migration Safety (post-launch — see section below)
  ├── LLD 65: Tonk Rules Spec        [shipped]
  ├── LLD 69: Tonk Engine (#57)      [shipped]
  ├── #83: Prod schema drift cleanup [sequence first]
  ├── Migration Safety LLD (prereq tier) [blocks #60's games-table migration]
  ├── #58 / #59: Tonk board + actions UI (blocked: frontend mockups)
  └── #60: Tonk game-flow integration (depends on: #58, #59, migration-safety prereq tier)
```

> Note: the original Phase 5B listed "Rematch + Invite UX" and "Animations + Polish" as
> LLD 12/13. Those numbers were reused post-launch (LLD 12 = Supabase SDK migration, LLD 13 =
> Railway sleep-on-idle). Rematch/restart is now tracked as issue **#64**; the polish items
> were absorbed into the shipped UX LLDs (27–60) listed in Current Status.

---

## Phase 1: Foundation  *(delivered)*

The infrastructure work. After this phase, we have auth, database, real-time communication, and the engine contract — ready for game logic.

### LLD 1: Supabase Migration  *(shipped)*

**Scope:** Replace custom auth + local Postgres with Supabase (local + cloud).

- Delete custom auth code (nonce flow, argon2, JWT signing, auth endpoints, crypto.ts)
- Integrate Supabase JS SDK (frontend: `signUp`, `signInWithPassword`, `getSession`)
- Backend JWT verification middleware (verify Supabase-issued JWTs)
- Database schema in Supabase (Game, PlayerStats tables via TypeORM migrations)
- Local dev setup (`supabase init`, `supabase start`, seed scripts)
- Environment config (.env.local vs .env.production)

**Depends on:** Nothing (first item)
**Outputs:** Working auth flow, DB connected, local Supabase running

> **Post-launch note:** the TypeORM-managed schema this LLD created is the origin of the
> prod schema drift (`*_pkey1` constraint names, stray grants) addressed by #83 and the
> migration-safety LLD. `001_create_tables.sql`'s `CREATE TABLE IF NOT EXISTS` no-op'd
> against the pre-existing TypeORM tables in prod, so TypeORM's constraint names and grants
> persist there but not in fresh CI/local DBs. See Phase 6.

---

### LLD 2: Game Engine Interface  *(shipped)*

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

### LLD 3: WebSocket Layer  *(shipped)*

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

## Phase 2: Core Game  *(delivered)*

The game logic and guest access. After this phase, Big2 is playable via WebSocket (no UI).

### LLD 4: Big2 Rules + Engine  *(shipped)*

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

### LLD 5: Guest Access  *(shipped)*

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

## Phase 3: Frontend  *(delivered)*

The game UI. After this phase, Big2 is playable in the browser.

### LLD 6: Frontend Game UI  *(shipped)*

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

### LLD 6.5: Integration Test Suite  *(shipped; followed by 6.6 E2E infra, 6.7 frontend flows, 6.8 guest tests)*

**Scope:** Backend integration tests that verify cross-layer behavior against real Supabase.

- Vitest + supertest + socket.io-client test infrastructure
- Docker Compose test environment (backend + Supabase, no frontend)
- Test helpers: Supabase user creation, JWT retrieval, authenticated socket connections
- Critical flow tests: auth (ES256 JWT), game CRUD, WebSocket game play, guest flow
- GitHub Actions workflow (boots Supabase, runs integration tests)
- Convention for Phase 4+ LLDs to add integration tests

**Depends on:** All of Phase 1-3 (needs working auth, engine, WebSocket, and guest access)
**Outputs:** Integration tests catching cross-layer bugs, CI pipeline running them on every PR

> **Post-launch note:** the CI suite (`.github/workflows/ci.yml`) boots Supabase with
> `supabase start`, which builds a **clean** DB every run. This is exactly why prod schema
> drift is invisible in CI ("green CI, drifted prod"). The migration-safety LLD (Phase 6)
> adds a drift-detection gate against the **linked prod** DB to close this gap.

---

## Phase 4: Online Features  *(delivered)*

Features that make it a full multiplayer experience.

### LLD 7a: Turn Timer  *(shipped)*

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

### LLD 7b: Player Stats  *(shipped; superseded by LLD 66 for per-game-type keying)*

**Scope:** Persistent player statistics recorded on game completion.

- PlayerStats entity: games played, won, lost, total score, last played timestamp
- Atomic `incrementStats` via SQL `ON CONFLICT DO UPDATE SET col = col + $n`
- StatsService: fire-and-forget recording on game completion, guest filtering
- `GET /stats` endpoint: returns stats + computed winRate for authenticated user
- Stats recorded when game transitions to COMPLETED (covers both player action and timer auto-play)

**Depends on:** LLD 4 (Big2 engine), LLD 7a (timer auto-play triggers completion)
**Outputs:** Stats tracked and queryable via REST

> **Post-launch note:** LLD 66 re-keyed `player_stats` to `(user_id, game_type)` so Big2 and
> Tonk records are independent. The fire-and-forget recording design from this LLD is why the
> half-applied-migration failure mode (Phase 6) is **silent** (lost stats, no crash) — a key
> input to the migration-safety LLD's "fail-closed verification" requirement.

---

### LLD 8a: Spectating  *(shipped)*

**Scope:** Non-player viewing of in-progress games.

- Spectator WebSocket role: join room as viewer, receive SpectatorView only
- Spectator entry: arrive at in-progress game → offered spectator mode
- Spectator count broadcast to players ("2 watching")
- Spectator room management (separate from player rooms, no action permissions)
- Spectator receives turnDeadline enrichment (consistent with players)

**Depends on:** LLD 3 (WebSocket layer)
**Outputs:** Spectators can watch live games without participating

---

### LLD 8b: Reconnection + Disconnect Handling  *(shipped)*

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

## Phase 5A: Playtest Readiness  *(delivered — app is live)*

Get the app into real users' hands with a feedback loop.

---

### LLD 9: Feedback Widget  *(shipped)*

**Scope:** In-app feedback mechanism for playtesters.

- Floating "Feedback" button (always visible during gameplay)
- Modal with: category dropdown (Bug / Confusing UX / Feature Request / Other), free-text description
- Auto-captures: current route, game status, user type (guest/registered), browser/viewport
- `POST /feedback` endpoint stores submissions in Supabase `feedback` table
- No admin UI for v1 — query Supabase dashboard directly to read feedback

**Depends on:** LLD 6 (Frontend Game UI)
**Outputs:** Playtesters can submit structured feedback from within the app

> A `feedback`-deletion admin endpoint shipped later as LLD 40. Feedback triage is handled
> by the `triage-feedback` workflow.

---

### LLD 10: Deployment  *(shipped — live on Railway)*

**Scope:** Get the app running online.

- Environment configuration (Supabase cloud project, env vars for production)
- Docker setup for production (Express server, no local Supabase)
- TLS/HTTPS (reverse proxy or PaaS-managed)
- Domain setup
- CI/CD (optional: GitHub Actions for build + deploy on push)
- Monitoring basics (health check endpoint, error logging)

**Depends on:** Phase 1 (foundation must be stable)
**Delivered:** Railway auto-deploys `Dockerfile.production` on merge to `main` (nginx reverse
proxy + Node backend via `docker-entrypoint.sh`); `/health` endpoint; Railway sleep-on-idle
(LLD 13). Domain: `danbing.app`.

> **Critical gap surfaced post-launch:** the deploy path **applies no database migrations**.
> Railway ships application *code* on merge; `supabase/migrations/*` are applied to prod by a
> **separate manual** `supabase db push`. This decoupling is the structural cause of the
> LLD 66 prod incident and is the problem the migration-safety LLD (Phase 6) addresses.

---

## Phase 5B: Polish  *(delivered across LLDs 11, 14, 27–60)*

Driven by playtesting feedback. The original LLD 11/12/13 numbering below was the
beginning-of-project plan; the actual polish work shipped under a wider range of LLD numbers
(see Current Status). Retained here as the original intent.

### LLD 11: Mobile Layout  *(shipped; extended by 27/28/32/36/39/42/58/60)*

**Scope:** Responsive game board for mobile devices.

- Touch-friendly card selection and actions
- Viewport handling (safe areas, orientation)
- Responsive breakpoints for game board, lobby, and stats screens

**Depends on:** LLD 6 (Frontend Game UI)
**Outputs:** Playable on mobile browsers

---

### LLD 12 (original): Rematch + Invite UX  *(partially delivered; rematch tracked as #64)*

**Scope:** Streamline multi-game sessions and player invitations.

- Rematch flow: same players, new game with one click from game-over screen
- Copy link button for game invites
- Native share on mobile (Web Share API)

> **Status:** invite-code copy/share shipped (LLD 28/36/48). A restart/play-again button is
> still open as issue **#64**. (Note: the "LLD 12" number was later reused for the Supabase
> SDK migration — see Current Status.)

---

### LLD 13 (original): Animations + Polish  *(delivered piecemeal)*

**Scope:** Visual feedback and UI delight.

- Card animations (deal, play transitions)
- Toast notifications (player joined, timer warning, connection status)
- Loading/transition states between screens
- Game log panel (recent actions in sidebar)
- Sound effects (optional)

> **Status:** card-selection animation shipped (LLD 27/35/36/39/42); game-over final-cards
> delay shipped (LLD 43). Remaining polish is opportunistic, driven by feedback. (The "LLD 13"
> number was later reused for Railway sleep-on-idle — see Current Status.)

---

## Phase 6: Tonk Productization + Migration Safety  *(active — post-launch)*

This phase is **issue-driven**, not pre-planned. It makes Tonk a first-class selectable game
and hardens the prod migration path that the LLD 66 rollout exposed as fragile.

### Tonk groundwork  *(shipped)*

- **LLD 65: Tonk Rules Spec** — the exact Tonk variant, signed off 2026-06-28. Hard docs-only
  gate; cleared.
- **LLD 69: Tonk Engine (#57)** — pure, server-authoritative `TonkEngine` against the
  `GameEngine` interface. Backend-only; proves the engine abstraction supports a second game.

### Tonk consumer chain  *(active frontier)*

Makes Tonk selectable and playable end-to-end. Sub-issues of epic **#41**:

- **#58 — Tonk board rendering.** Read-only board: hand, discard pile, stock, tallies.
  `blocked:frontend-decision` — needs a `frontend-architect` HTML mockup approved before the
  LLD per CLAUDE.md.
- **#59 — Tonk player-actions UI.** Discard, draw, TONK declaration. `blocked:frontend-decision`
  — needs mockup.
- **#60 — Tonk game-flow integration.** Game-type selection (3–8 players), lobby,
  `deckRoundsTarget` creator-config plumbing, loss-centric stats wiring. **Ships a new
  `games`-table migration** (the `deckRoundsTarget` column) against the same drifted prod DB.

**Depends on:** LLD 69 (engine, shipped), LLD 66 (per-game-type stats, shipped). #60 depends
on #58 + #59 and on the migration-safety prerequisite tier (below).

### Prod schema drift cleanup — #83  *(sequence FIRST)*

Clean up the TypeORM-era drift surfaced by the LLD 66 incident: `*_pkey1` constraint names on
`games` / `feedback`, and stray `anon` INSERT/UPDATE/DELETE grants (RLS-neutralized but
unnecessary surface). Sequenced **before** the migration-safety LLD so the drift-detection
gate has a clean, known baseline to assert against. (The `player_stats` PK was already
repaired by migration `006` in PR #81; #83 is the remaining two tables + grant hygiene.)

### Migration Safety + Automation LLD  *(Architect-owned, re-scoped)*

**Context — the LLD 66 prod incident.** Migration `004` repointed `player_stats`'s PK by a
**hardcoded** constraint name (`player_stats_pkey`). Prod's PK was `player_stats_pkey1` — a
TypeORM-era leftover (see LLD 1 note). The hardcoded drop matched nothing, the composite PK
was never applied, and every stats write would have errored on prod once the 6-arg RPC
deployed. **CI was green** because `supabase start` builds clean DBs with the conventional
name. The failure was **silent** (a NOTICE, not an error) and was caught only because a human
ran a manual post-apply verification `SELECT` before merging the consuming backend. A
follow-up `supabase db diff --linked` revealed broader pre-existing drift (#83).

**Root cause (structural, recurring):** our test/CI environments (fresh Supabase DBs) do not
represent prod's actual state (which carries TypeORM-era history). Every future migration
risks the same "green CI, broken prod" silent failure. The Tonk consumer chain (#60) ships
more schema changes against this same drifted prod DB.

**Scope decision: ONE work item, not split.** Drift detection, prod-shaped test environment,
and a post-apply verification gate are the three legs of a single capability — "apply a
migration to prod and *know* it did what the migration says." Splitting them produces
dangerous half-states (e.g. automating `db push` without drift detection would automate the
silent failure). They share one threat model, one owner, one mechanism recommendation.

**Tiered delivery:**

**Prerequisite tier — HARD BLOCKER before #60's first `games`-table migration reaches prod.**
The shipping model is human-monitored but **not strict per-release** (loosely monitored larger
launch), so a human will not reliably run the post-apply verification on every migration. The
automated controls must close the gap:

1. **Drift-detection gate (fail-closed).** A CI / pre-deploy job runs `supabase db diff --linked`
   against prod and **fails the build** if the diff is anything other than an explicitly
   allowlisted, expected set (distinguishing "expected pending migration" from "unexpected
   drift"). Warn-only is not acceptable.
2. **Scripted post-apply verification gate.** The manual `SELECT` that saved us (LLD 66 §8.3
   release checklist) becomes a required, scripted, non-skippable step: each migration declares
   a machine-checkable post-condition; the release is blocked until it passes.
3. **Prod-shaped test fixture.** Migrations must be testable against a DB that carries prod's
   TypeORM-era history (drifted constraint names, grants), not a pristine `supabase start`. The
   prod-shaped test built for migration `006` in PR #81 is the seed pattern; generalize it into
   a reusable CI fixture. **This is the leg that would have caught `004` at test time.**

The prerequisite tier must close the "green CI, broken prod" gap **on its own**, independent of
whether the scheduled tier ever ships.

**Scheduled tier — original timing (after #57, opportunistic; #57 is shipped).**

4. Automated, idempotent, fail-closed `supabase db push` (or chosen mechanism) wired into the
   deploy path, **gated by** items 1–3 so automation never runs ahead of verification. The
   Architect owns the mechanism recommendation (pipeline step vs. GitHub Action vs. entrypoint
   hook) and must account for the Railway auto-deploy-on-merge ordering hazard (LLD 66 §8.3):
   the backend must never deploy ahead of its schema.

**Depends on:** #83 (clean baseline) sequenced first.
**Blocks:** #60 (its `games`-table migration must not reach prod until the prerequisite tier is
in place).

---

## Summary

| Phase                  | LLDs / work    | Status | Key Milestone                                              |
| ---------------------- | -------------- | ------ | ---------------------------------------------------------- |
| 1. Foundation          | 1, 2, 3        | Shipped | Auth, DB, WebSocket, engine interface — infrastructure ready |
| 2. Core Game           | 4, 5           | Shipped | Big2 playable via WebSocket, guests can join               |
| 3. Frontend            | 6, 6.5–6.8     | Shipped | Big2 playable in browser + test safety net                 |
| 4. Online Features     | 7a, 7b, 8a, 8b | Shipped | Timer, stats, spectating, reconnection                     |
| 5A. Playtest Readiness | 9, 10          | Shipped | Feedback widget, deployment — **app live on Railway**      |
| 5B. Polish             | 11, 14, 27–60  | Shipped | Mobile, animations, UX fixes — driven by playtester feedback |
| 6. Tonk + Migration Safety | 65, 69, #58–#60, #83, Migration-Safety LLD | **Active** | Tonk selectable end-to-end; prod migrations safe from silent failure |

**Original roadmap (Phases 1–5B) is delivered; the app is live.** Phase 6 is the active,
issue-driven frontier: productize Tonk and harden the prod migration path. LLDs continue to be
written just before implementation, not all upfront.
