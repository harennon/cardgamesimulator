# Changelog

All notable changes to this project. Updated with every commit.

Format: each entry has a date, short description, and category. Most recent first.

---

## [Unreleased]

### Fixed

- **LLD 44: Home Buttons Centering** — "Create Game" and "Join Game" buttons now properly centered on home page across all viewport widths by adding `width: 100%` to `.home` scoped style in `HomeView.vue`

### Added

- **LLD 40: Admin DELETE Endpoint for Feedback** — admins can now delete individual feedback entries via `DELETE /feedback/:id`
  - `src/backend/database/database.ts` — added `deleteFeedback(id: string): Promise<boolean>` to `FeedbackRepository` interface
  - `src/backend/database/supabaseDb.ts` — implemented `deleteFeedback` using service-role client with `.delete().eq("id", id).select("id")` pattern to detect 404
  - `src/backend/api/feedback/submitFeedback.ts` — added `DELETE /:id` route on `FeedbackHandler` with admin gate (reuses `getAdminIds()`) and 404 handling
  - `scripts/feedback.mjs` — added `--delete <id>` flag with usage guard
  - `tests/integration/feedback.test.ts` — 5 new integration tests: 403 for non-admin, 401 without auth, 404 for missing ID, 200 happy path with GET verification, double-delete idempotency


- **LLD 38: Post-Match Stats on Game Over Screen** — game over screen now shows per-game performance stats for the current player
  - `src/frontend/component/game/gameOverStats.ts` — stat derivation utility: `deriveBig2Stats` computes Plays Made, Passes, Tricks Won, Best Hand from `playHistory`; `countTricksWon` detects trick-winning sequences; `getBestHand` ranks hand types; placement badge helpers (`getBadgeForPosition`, `getBadgeClass`)
  - `src/frontend/component/game/GameOverView.vue` — enhanced with placement badges (gold/silver/bronze/grey CSS circles), "Total Turns" metadata bar, 2x2 stats grid with staggered slide-up entrance animations, `prefers-reduced-motion` support, mobile responsive
  - `src/frontend/component/game/GameView.vue` — passes `playHistory`, `currentPlayerId`, and `totalTurns` props to `GameOverView` from `gameSpecificPublicState`
  - `tests/frontend/gameOverStats.test.ts` — 13 unit tests: play/pass counting, trick detection, hand type ranking, empty history, player isolation, placement badge mapping

- **LLD 32: Mobile Responsiveness for Non-Game Screens** — all pre-game and post-game screens (Home, Login, Guest Entry, Create Game, Join Game, Game Lobby, Game Over) are now mobile-responsive at 375px viewports with no horizontal overflow and touch-friendly tap targets
  - `src/frontend/styles/game-variables.css` — added `--card-panel-padding: 28px 20px` and `--page-max-width: 100%` overrides inside existing `@media (max-width: 767px)` block
  - `src/frontend/styles/flows.css` — appended `@media (max-width: 767px)` block: `.flow-page` padding/alignment, `.form-card__input` min-height 44px + font-size 16px (prevents iOS zoom), `.btn-primary` / `.btn-secondary` min-height 48px + flex centering
  - `src/frontend/component/GuestEntryView.vue` — refactored template to use `flow-page` + `form-card` + `form-card__field` / `form-card__label` / `form-card__input` / `form-card__error` / `form-card__divider` / `form-card__footer` classes; removed entire `<style scoped>` block
  - `src/frontend/component/game/GameLobbyView.vue` — added `@media (max-width: 767px)` scoped block: removes `min-width` on `.lobby__panel`, full-width buttons, `.lobby__invite` stacks vertically
  - `src/frontend/component/game/GameOverView.vue` — added `@media (max-width: 767px)` scoped block: removes `min-width` on `.game-over__panel`, reduces table font/padding, `.game-over__actions` stacks vertically, full-width buttons

### Fixed

- **LLD 36: Card Selection Animation Feels Slow on Mobile (rAF fix)** — eliminates the 1-frame visual gap between tap and card lift on Firefox Android and lower-end mobile GPUs
  - `src/frontend/composables/useCardSelection.ts` — `toggleCard` now wraps the reactive assignment in `requestAnimationFrame` to align the DOM class change with the compositor frame boundary; a `pending` accumulator batches rapid same-frame multi-taps so no taps are lost; `clearSelection` nullifies `pending` before writing to prevent a stale rAF from overwriting the clear
  - `src/frontend/component/game-ui/GameCard.vue` — added `will-change: transform` to `.card--interactive` to force GPU layer promotion, allowing the compositor to apply the `translateY` change without a main-thread layout/paint cycle
  - `tests/frontend/useCardSelection.test.ts` — globally stubs `requestAnimationFrame` to run synchronously so existing tests remain unaffected; adds three new rAF batching tests: rapid multi-tap batching, toggle-then-untoggle in same frame, and `clearSelection` cancels pending rAF

- **LLD 27: Card Selection Animation Feels Slow on Mobile** — card selection lift is now instant on mobile viewports (<=767px) and for users with `prefers-reduced-motion: reduce`; desktop retains the existing 150ms ease transition
  - `src/frontend/styles/game-variables.css` — added `--card-select-duration: 150ms` and `--card-select-easing: ease` to `:root`; overridden to `0ms`/`linear` inside the existing `@media (max-width: 767px)` block and a new `@media (prefers-reduced-motion: reduce)` block
  - `src/frontend/component/game-ui/GameCard.vue` — replaced hardcoded `transition: transform 0.15s ease, ...` with `var(--card-select-duration)` and `var(--card-select-easing)` references

### Added

- **LLD 28: Mobile Invite Code** — short 4-character room code for easy mobile sharing
  - `supabase/migrations/004_join_codes.sql` — `join_codes` table (code PK → game_id FK, created_at); index on game_id; SELECT grants to authenticated/anon
  - `src/backend/database/database.ts` — `JoinCodeRepository` interface (`createJoinCode`, `getGameIdByCode`, `deleteByGameId`, `deleteExpired`)
  - `src/backend/database/supabaseDb.ts` — `SupabaseDB` implements `JoinCodeRepository`; `deleteExpired` uses ISO cutoff timestamp
  - `src/backend/database/index.ts` — exports `joinCodeRepo`
  - `src/backend/service/joinCodeService.ts` — `JoinCodeService`: generates 4-char codes from reduced alphabet (A-Z minus O/I/L, 2-9); in-memory cache; retry on collision; `resolveCode` normalises to uppercase; `cleanupExpired` delegates to repo
  - `src/backend/api/game/resolveJoinCode.ts` — `GET /api/games/join/:code` router; no auth; 200 `{gameId}` or 404
  - `src/backend/api/game/createGame.ts` — calls `joinCodeService.generateCode` before `gameRepo.createGame`; `joinCode` included in `CreateGameResponse`
  - `src/backend/websocket/socketHandler.ts` — `handleGameJoin` resolves join code and includes it in `lobby:state` payload; `registerSocketHandlers` accepts `JoinCodeService`
  - `src/backend/server.ts` — instantiates `JoinCodeService`; registers `/games/join` route; passes service to socket handler; runs hourly cleanup interval (24h max age); `close()` clears interval
  - `src/shared/model.ts` — `CreateGameResponse.joinCode: string`; new `ResolveJoinCodeResponse`
  - `src/shared/socket-events.ts` — `LobbyStatePayload.joinCode: string`
  - `src/frontend/component/game/GameLobbyView.vue` — casino chip display: gold-bordered monospace element with "ROOM CODE" label; tap-to-copy with "Copied!" toast; clipboard fallback "Long-press to copy."; `joinCode` prop added; mobile responsive (`1.6rem` at `< 480px`)
  - `src/frontend/component/game/GameView.vue` — `lobbyJoinCode` ref populated from `lobby:state`; passed to `GameLobbyView`
  - `src/frontend/component/JoinGameView.vue` — detects 4-char codes vs UUIDs; resolves short codes via `GET /api/games/join/:code` before joining; `text-transform: uppercase` input style; placeholder updated
  - `tests/service/joinCodeService.test.ts` — 12 unit tests: code length/alphabet/case, collision retry, error propagation, cache population, case normalisation, delete cache eviction, cleanup delegation
  - `tests/api/resolveJoinCode.test.ts` — 3 endpoint tests: 200 with gameId, uppercase normalisation, 404 for unknown code
  - `tests/frontend/gameLobbyView.test.ts` — 6 tests: chip display, copy-to-clipboard success/failure, invite link copy
  - `tests/frontend/joinGameView.test.ts` — 12 tests: UUID/short-code/invalid classification, full join flows, error cases

- **LLD 13: Railway Sleep-on-Idle** — enable `sleepApplication: true` by removing `setInterval` loops that kept the process alive and adding turn-timer recovery on wake
  - `src/backend/engine/game-cache.ts` — replaced periodic eviction loop with lazy on-access eviction (check inactivity threshold on `get()`, sweep stale entries on `set()`)
  - `src/backend/guest/guestSessionStore.ts` — replaced periodic cleanup loop with lazy expiry deletion in `getByGame()`
  - `src/backend/websocket/socketHandler.ts` — added timer recovery in `handleGameJoin`: if an IN_PROGRESS game has no active timer after wake, immediately trigger timeout
  - `railway.json` — `sleepApplication: true`

- **LLD 12: Supabase SDK Migration** — replaced TypeORM with `@supabase/supabase-js` for all DB operations; added Row-Level Security
  - `supabase/migrations/001_create_tables.sql` — snake_case schema for `games`, `player_stats`, `feedback` tables with indexes
  - `supabase/migrations/002_enable_rls.sql` — RLS enabled on all three tables; policies restrict direct PostgREST access (service-role bypasses automatically)
  - `supabase/migrations/003_increment_stats_rpc.sql` — `increment_player_stats` stored procedure for atomic upsert; restricted to `service_role`
  - `src/backend/database/supabaseDb.ts` — `SupabaseDB` class implementing all three repository interfaces via Supabase JS SDK; synchronous `initialize()` validates env vars; snake_case→camelCase mappers; optimistic locking via `WHERE version = $n`
  - `src/backend/util/errors.ts` — added `OptimisticLockError` (status 409) replacing TypeORM's `OptimisticLockVersionMismatchError`
  - `src/backend/database/index.ts` — barrel now exports `SupabaseDB.INSTANCE` instead of `PostgresDB.INSTANCE`
  - `src/backend/server.ts` — `SupabaseDB.INSTANCE.initialize()` (sync, no await); removed `PostgresDB` import
  - `src/backend/api/game/joinGame.ts` — optimistic lock catch uses `instanceof OptimisticLockError`
  - `src/backend/database/entities/Game.ts`, `PlayerStats.ts`, `Feedback.ts` — removed all TypeORM decorators; plain classes
  - `src/backend/tsconfig.json` — removed `experimentalDecorators` and `emitDecoratorMetadata`
  - `package.json` — removed `typeorm`, `reflect-metadata`, `pg`, `pg-protocol`
  - `tests/database/supabaseDb.test.ts` — 11 unit tests: mapper correctness, optimistic lock error, env validation, `OptimisticLockError` class contract
  - Deleted `src/backend/database/postgres.ts`

### Fixed

- **Hotfix: Lobby real-time player list** — fixed race condition where players already in the lobby did not see newly joined players without a page refresh
  - `src/shared/socket-events.ts` — added `LobbyStatePayload` interface and `lobby:state` event to `ServerToClientEvents`
  - `src/backend/websocket/socketHandler.ts` — on `game:join` for CREATED games, emits `lobby:state` to the joining socket with the full authoritative player list before the incremental `lobby:playerJoined` broadcast to others
  - `src/frontend/component/game/GameView.vue` — registers `lobby:state` listener that replaces `lobbyPlayers` with the server-authoritative list, closing the race window between REST fetch and socket room join
  - `tests/websocket/socketHandler.test.ts` — 4 unit tests covering CREATED/IN_PROGRESS/COMPLETED branches and displayName fallback

- **Hotfix: Invite link auth bypass** — registered users visiting `/game/:gameId/join` are now joined directly using their Supabase session and redirected to the game view; unauthenticated users continue to see GuestEntryView as before
  - `src/frontend/routes.ts` — exported `joinRouteGuard` function added as `beforeEnter` on the `/game/:gameId/join` route; calls `POST /api/joinGame` with the authenticated token and redirects to `/game/:gameId` on success (or home on 404)
  - `vitest.config.ts` — extended frontend service alias to include `http`, added `@/component` alias for testability
  - `tests/frontend/joinRouteGuard.test.ts` — 5 unit tests covering authenticated join, unauthenticated fallthrough, 404, 409, and network error cases

- **Hotfix: Mobile Firefox game board layout** — cards and play/pass buttons now visible on Firefox Android (378x707 viewport)
  - `src/frontend/component/game/GameBoard.vue` — added `height: 100dvh` (with `100vh` fallback) to override `inset: 0` block axis on mobile; `overflow: hidden` fallback before `overflow: clip`; `min-height: 0` on `.game-board__table` to allow Firefox's 1fr row to shrink; `overflow: hidden` on `.game-board__hand` to create intermediate scroll context

- **LLD 12 code review**: removed fragile `error.message.includes("0 rows")` fallback from `saveGame` — `PGRST116` error code check alone is sufficient per PostgREST docs
- **LLD 12 code review**: reduced `as unknown as` casting in `supabaseDb.test.ts` — extracted `makeTestInstance()` helper and call public methods directly on typed `db` variable
- **LLD 12 code review**: added `tests/integration/rls.test.ts` — RLS and security integration tests (integration tests 4–6 and security tests 1–3 from LLD section 10); verifies SELECT isolation, UPDATE blocking, stats isolation, anon INSERT rejection, RPC access restriction

### Changed

- **LLD 11: Mobile Layout (Stacked Compact)** — responsive game board for viewports below 767px
  - `src/frontend/styles/game-variables.css` — card sizing tokens (`--card-hand-width`, `--card-hand-height`, `--card-overlap`, `--card-selected-lift`, `--card-hover-lift`, `--card-selected-hover-lift`), mobile layout tokens, `@media (max-width: 767px)` override block for smaller card sizes, `prefers-reduced-motion` block
  - `src/frontend/component/game-ui/GameCard.vue` — `.card--medium` and `.card--large` use `var(--card-hand-width/height)` instead of hardcoded 64×90px; `.card--selected` uses `var(--card-selected-lift)` instead of hardcoded -20px
  - `src/frontend/component/game-ui/PlayerHand.vue` — `.player-hand__card` uses `var(--card-overlap)` and `var(--card-hover-lift/selected-hover-lift)`; mobile media query adds `width: 100%`, 20px top padding for selected card overflow, touch scroll, hidden scrollbar
  - `src/frontend/component/game/GameBoard.vue` — `isMobile` + `logDrawerOpen` refs with full matchMedia lifecycle and Escape key handler; `game-board--mobile` class binding; stacked single-column grid override (`overflow: clip`); hand label showing card count; log drawer via `<Teleport to="body">` with slide-in transform animation; hamburger toggle button (mobile only); unscoped styles for drawer and toggle
  - `src/frontend/component/game-ui/OpponentRow.vue` — mobile media query hides card-back visuals, switches to horizontal pill layout with truncated names
  - `src/frontend/component/game-ui/ActionPanel.vue` — mobile media query locks row to 56px height, sets button font to 0.85rem
  - `tests/frontend/gameBoardMobile.test.ts` — 14 unit tests covering isMobile ref, logDrawerOpen toggle, Escape key handler, matchMedia listener cleanup
  - `e2e/mobile-layout.spec.ts` — 7 E2E tests: mobile class present at 375x667, log panel hidden, toggle visible, drawer opens on click, Escape closes drawer, hand scrollable with 13 cards, desktop regression (no mobile class at 1024x768)

- **nginx reverse proxy in production container** — dev/prod parity by running nginx in front of Express inside the Railway container
  - `nginx/production.conf` — nginx config template: listens on `$PORT`, serves static files from `/app/build/frontend/`, SPA fallback, proxies `/api/`, `/health`, `/socket.io/` to Express on localhost:3000
  - `docker-entrypoint.sh` — shell entrypoint: substitutes `$PORT` via envsubst, starts nginx and node concurrently, exits container if either process dies so Railway restarts it
  - `Dockerfile.production` — installs nginx + gettext (envsubst), copies config template and entrypoint, uses `/docker-entrypoint.sh` as CMD
  - `src/backend/server.ts` — removed production static file serving block (nginx handles it now); Express port now uses `BACKEND_PORT || 3000` (not `PORT` which Railway injects to nginx)

- **LLD 10: Deployment** — production deployment configuration for Railway
  - `src/backend/server.ts` — production static file serving (`build/frontend/`) with SPA fallback after all API routes; PORT env var checked before BACKEND_PORT (Railway injects PORT)
  - `src/backend/database/postgres.ts` — SSL enabled for Supabase Postgres connection in production (`rejectUnauthorized: false`)
  - `src/backend/index.ts` — `unhandledRejection` handler logs to stderr to prevent silent crashes
  - `Dockerfile.production` — multi-stage Docker image: builder stage compiles frontend + backend with VITE_* build ARGs; runtime stage uses node:22.14-alpine, non-root user, prod-only deps, HEALTHCHECK via wget
  - `.github/workflows/ci.yml` — deploy job added: runs after all test jobs pass on push to main; installs Railway CLI and runs `railway up`
  - `tests/api/deployment.test.ts` — 3 unit tests: health endpoint shape, static middleware registered when production, static middleware absent when non-production
  - `tests/fixtures/mock-frontend/index.html` — minimal HTML fixture for static serving tests

- **LLD 9: Feedback Widget** — in-app feedback mechanism for playtesters
  - `src/shared/model.ts` — `FeedbackCategory`, `SubmitFeedbackRequest`, `SubmitFeedbackResponse` types
  - `src/backend/database/entities/Feedback.ts` — TypeORM entity with `id`, `category`, `description`, `metadata` (jsonb), `userId`, `createdAt` columns
  - `src/backend/database/database.ts` — `FeedbackRepository` interface (`createFeedback`)
  - `src/backend/database/postgres.ts` — `createFeedback` implementation; `Feedback` entity added to DataSource
  - `src/backend/database/index.ts` — `feedbackRepo` export
  - `src/backend/service/feedbackService.ts` — `FeedbackService` with category/description validation; `ValidationError` class
  - `src/backend/api/feedback/submitFeedback.ts` — `POST /feedback` handler; 201 on success, 400 on validation errors
  - `src/backend/server.ts` — `/feedback` route registered with `authMiddleware` (guests + registered)
  - `src/frontend/component/FeedbackWidget.vue` — floating button (bottom-right), modal with category/description form, "Thanks!" toast; auto-captures route/browser/viewport metadata
  - `src/frontend/component/App.vue` — `FeedbackWidget` mounted globally
  - `tests/service/feedbackService.test.ts` — 13 unit tests covering all 4 categories, empty/whitespace/over-500 description, invalid category, trim, metadata passthrough, null userId, return value
  - `tests/integration/feedback.test.ts` — 7 integration tests: registered user 201, guest user 201, empty description 400, invalid category 400, unauthenticated 401, metadata stored correctly, description trimmed

- `tests/helpers/seedState.ts` — `buildGameState()` and `buildCompletedState()` helpers for constructing deterministic `InternalGameState` fixtures in tests (LLD test-coverage-gaps)
- `tests/helpers/seedState.test.ts` — 9 unit tests covering state construction invariants, deterministic hands, COMPLETED validation, custom hands (LLD test-coverage-gaps)
- `src/backend/api/test/seedState.ts` — `POST /test/seed-state` endpoint; seeds game cache and DB atomically; returns 403 when `NODE_ENV !== "test"`, 404 when game not found (LLD test-coverage-gaps)
- `tests/integration/game-validation.test.ts` — 7 integration tests: invalid card combo rejected via WebSocket ack, card not in hand rejected, joinGame 409 when full, game:start NOT_ENOUGH_PLAYERS with 1 player, joinGame 409 on IN_PROGRESS full game, seed endpoint succeeds in test env, seed endpoint 404 for non-existent game (LLD test-coverage-gaps)
- `tests/integration/scoring.test.ts` — 2 integration tests: 4-player placement scoring [5,3,1,0], 2-player scoring [5,0] (LLD test-coverage-gaps)
- `e2e/helpers/seed-helpers.ts` — `seedGameState()` and `seedCompletedGame()` Playwright helpers for seeding game state via REST before E2E navigation (LLD test-coverage-gaps)
- `e2e/game-over.spec.ts` — 3 E2E tests: game-over renders with scores/winner, guest sees sign-up nudge, registered user does not see nudge (LLD test-coverage-gaps)
- `e2e/lobby.spec.ts` — 2 E2E tests: start button disabled with 1 player, copy invite link shows Copied! feedback (LLD test-coverage-gaps)
- `e2e/join-game.spec.ts` — 1 E2E test: joining a full game shows error message (LLD test-coverage-gaps)

### Changed

- `tests/integration/helpers/testServer.ts` — `TestServerContext` now exposes `gameCache` and `gameService`; seed endpoint registered unconditionally (always available in integration test server) (LLD test-coverage-gaps)
- `e2e/helpers/game-helpers.ts` — added `readStoredAuth()`, `createGameViaApi()`, `joinGameViaApi()` for REST-based game setup in E2E tests without browser interaction (LLD test-coverage-gaps)
- `src/backend/server.ts` — seed endpoint conditionally registered via dynamic import when `NODE_ENV=test` (LLD test-coverage-gaps)

- `tests/integration/reconnection.test.ts` — 12 integration tests for LLD 8b simplified reconnection: disconnect/reconnect events, `isConnected` status in state, turn-timer-expiry-marks-abandoned, auto-pass chaining through abandoned players, reconnect clears abandoned, multiple abandoned players, lobby disconnect, multi-tab, null timer rejected, game completion cleanup (LLD 8b rewrite)

### Changed

- `src/backend/websocket/connectionManager.ts` — added `abandonedPlayers` map with `markAbandoned`, `clearAbandoned`, `isAbandoned`, `clearGameAbandoned` methods (LLD 8b)
- `src/backend/websocket/socketHandler.ts` — replaced `DisconnectTimerService`-based grace period with turn-timer-driven abandonment: `autoPlayAbandoned` loop (renamed from `autoPassAbandoned`); `handleTimerExpired` marks disconnected player abandoned after auto-pass; `handleGameJoin` calls `clearAbandoned` on reconnect; `handleDisconnect`/`handleGameLeave` emit disconnect events without grace period timer; removed `handleGracePeriodExpired`; `registerSocketHandlers` no longer takes `DisconnectTimerService` parameter; game completion calls `clearGameAbandoned` (LLD 8b)
- `src/backend/api/game/createGame.ts` — `turnTimerSeconds` now required; null or missing value returns 400; valid values remain 30/60/90 (LLD 8b)
- `src/shared/model.ts` — `CreateGameRequest.turnTimerSeconds` type changed from `number | null | undefined` to `30 | 60 | 90` (required) (LLD 8b)
- `src/backend/server.ts` — removed `DisconnectTimerService` instantiation and `handleGracePeriodExpired` callback; simplified `registerSocketHandlers` and `handleTimerExpired` calls (LLD 8b)
- `src/frontend/component/CreateGameView.vue` — added turn timer selector (30/60/90s, default 60s); `turnTimerSeconds` included in create game request (LLD 8b)
- `tests/integration/helpers/testServer.ts` — removed `DisconnectTimerService`; `TestServerContext` now exposes `connectionManager` instead of `disconnectTimerService` (LLD 8b)
- `tests/websocket/connectionManager.test.ts` — 5 new unit tests for `markAbandoned`, `clearAbandoned`, `isAbandoned`, `clearGameAbandoned`, isolation (LLD 8b)
- `tests/api/createGame.test.ts` — updated for required `turnTimerSeconds`; added tests for null, missing, and invalid timer rejection (LLD 8b)
- `tests/integration/turn-timer.test.ts` — updated: "stores null turnTimerSeconds" replaced with "rejects game creation when no timer specified"; "emits null turnDeadline" replaced with equivalent test using required timer (LLD 8b)
- `tests/integration/game-crud.test.ts`, `websocket-game.test.ts`, `player-stats.test.ts`, `spectating.test.ts`, `auth.test.ts`, `guest-flow.test.ts` — all game creation calls updated to include `turnTimerSeconds: 30` (LLD 8b)

### Removed

- `src/backend/websocket/disconnectTimerService.ts` — eliminated; turn timer serves as the grace period (LLD 8b)
- `tests/websocket/disconnectTimerService.test.ts` — eliminated with the service (LLD 8b)

- `src/shared/socket-events.ts` — `SpectatorCountPayload` interface and `game:spectatorCount` event in `ServerToClientEvents` (LLD 8a)
- `src/backend/websocket/connectionManager.ts` — `isSpectator(socketId)` and `getSpectatorGameId(socketId)` methods (LLD 8a)
- `tests/websocket/connectionManager.test.ts` — 4 new unit tests for `isSpectator` and `getSpectatorGameId` behaviour (LLD 8a)
- `tests/integration/spectating.test.ts` — 14 integration tests covering spectator join/leave, state broadcasts, action guards, CREATED rejection, completion, and timer events (LLD 8a)

### Changed

- `src/backend/websocket/socketHandler.ts` — (1) Added `emitSpectatorCount` helper; (2) Spectator join now rejects CREATED games with `SPECTATING_NOT_AVAILABLE` and emits `game:spectatorCount` to players on join; (3) `handleGameAction` and `handleGameStart` guard against spectators with `SPECTATOR_CANNOT_ACT`; (4) `handleGameLeave` detects spectator via `getSpectatorGameId` before `removeSocket` and emits updated count; (5) `handleDisconnect` emits `game:spectatorCount` on spectator disconnect; (6) `handleTimerExpired` extends `game:timerExpired` to the spectator room (LLD 8a)

- `src/backend/timer/timerProvider.ts` — `TimerProvider` interface and `TimerHandle` type (LLD 7a)
- `src/backend/timer/realTimerProvider.ts` — `RealTimerProvider`: production implementation using `setTimeout`/`clearTimeout`; `cancelAll()` for server shutdown (LLD 7a)
- `src/backend/timer/fakeTimerProvider.ts` — `FakeTimerProvider`: test double with manual `fire(id)`, `fireAll()`, `pendingCount`, `lastScheduledId` (LLD 7a)
- `src/backend/timer/turnTimerService.ts` — `TurnTimerService`: manages per-game turn timers; `registerGame`, `startTurn` (1x/2x duration for first turn), `cancelTimer`, `unregisterGame`, `getDeadline`, `hasTimer` (LLD 7a)
- `tests/timer/turnTimerService.test.ts` — 13 unit tests for `TurnTimerService`: timer scheduling, 2x first-turn duration, cancellation, expiry callback, unregister, deadline accuracy, independent timers per game (LLD 7a)
- `tests/engine/big2/autoTimeout.test.ts` — 13 unit tests for `Big2Engine.getAutoTimeoutAction`: pass on normal turn, playCards on first play and free play, null for COMPLETED/CREATED/invalid index, action validity invariant (LLD 7a)
- `tests/integration/turn-timer.test.ts` — 12 integration tests: game creation with timer stored/validated, null/non-null `turnDeadline` in state events, 2x first-turn deadline, deadline updates after action, timer expiry auto-passes via `FakeTimerProvider`, `game:timerExpired` event emitted, timer restarts after action, timer cancelled on game completion (LLD 7a)

### Changed

- `src/backend/engine/game-engine.ts` — Added `getAutoTimeoutAction(state): GameAction | null` to `GameEngine` interface (LLD 7a)
- `src/backend/engine/big2/big2-engine.ts` — Implemented `getAutoTimeoutAction`: returns `pass` when legal, otherwise plays lowest card as single (first play / free play) (LLD 7a)
- `src/shared/model.ts` — Added `turnTimerSeconds?: number | null` to `CreateGameRequest`; added `turnTimerSeconds: number | null` to `SerializableGame` (LLD 7a)
- `src/shared/socket-events.ts` — Added `EnrichedPlayerView`, `EnrichedSpectatorView` (extends views with `turnDeadline: number | null`), `TimerExpiredPayload`, and `game:timerExpired` event to `ServerToClientEvents`; updated `game:state` and `game:spectatorState` to use enriched types (LLD 7a)
- `src/backend/database/entities/Game.ts` — Added nullable `turnTimerSeconds: number | null` column (LLD 7a)
- `src/backend/database/database.ts` — Added `turnTimerSeconds: number | null` parameter to `GameRepository.createGame` (LLD 7a)
- `src/backend/database/postgres.ts` — Passes `turnTimerSeconds` in `createGame` (LLD 7a)
- `src/backend/api/game/createGame.ts` — Validates `turnTimerSeconds` (must be null, 30, 60, or 90); passes to `gameRepo.createGame` (LLD 7a)
- `src/backend/util/serializer.ts` — Includes `turnTimerSeconds` in `serializeGameForPlayer` output (LLD 7a)
- `src/backend/websocket/socketHandler.ts` — Integrates `TurnTimerService`: register/start on game start, restart on action, unregister on completion; enriches all `game:state` and `game:spectatorState` emissions with `turnDeadline`; added exported `handleTimerExpired` function (LLD 7a)
- `src/backend/server.ts` — Instantiates `RealTimerProvider` and `TurnTimerService`, wires timer expiry callback, passes `TurnTimerService` to `registerSocketHandlers`, calls `timerProvider.cancelAll()` on close (LLD 7a)
- `tests/integration/helpers/testServer.ts` — Wires `FakeTimerProvider` and `TurnTimerService` into test server; exposes `timerProvider` and `turnTimerService` on `TestServerContext` (LLD 7a)
- `tests/service/gameService.test.ts` — Added `getAutoTimeoutAction` mock to `makeEngine` helper (LLD 7a)
- `tests/api/createGame.test.ts` — Updated `mockCreateGame` signature to include `turnTimerSeconds` parameter (LLD 7a)

- `src/backend/service/statsService.ts` — `StatsService` orchestrates stat recording on game completion; filters out guest players via `GuestSessionStore`; fire-and-forget per-player `incrementStats` calls with per-player error isolation (LLD 7b)
- `src/backend/api/stats/getStats.ts` — `GET /stats` handler returns authenticated user's stats with computed `winRate`; guests receive zeroed stats (LLD 7b)
- `tests/service/statsService.test.ts` — 8 unit tests for `StatsService`: guest filtering, winner/loser deltas, score extraction, early-return on non-COMPLETED, error isolation (LLD 7b)
- `tests/integration/player-stats.test.ts` — 7 integration tests: zeroed stats for new users, 401 without auth, guest zeroed stats, gamesPlayed incremented after game, winner/loser counts, guest excluded from DB after game, atomic concurrent upserts, winRate formula (LLD 7b)

### Changed

- `src/shared/model.ts` — Added `GetStatsResponse` interface (LLD 7b)
- `src/backend/database/database.ts` — Replaced `upsertStats` with atomic `incrementStats(userId, delta)` on `PlayerStatsRepository`; added `StatsDelta` interface (LLD 7b)
- `src/backend/database/postgres.ts` — Implemented `incrementStats` using raw SQL `INSERT ... ON CONFLICT DO UPDATE SET col = col + $n` (LLD 7b)
- `src/backend/service/gameService.ts` — Added `statsService` constructor parameter; fires `statsService.recordGameCompletion` (fire-and-forget) when game transitions to COMPLETED (LLD 7b)
- `src/backend/server.ts` — Instantiates `StatsService`, passes it to `GameService`, registers `/stats` route with `authMiddleware` (LLD 7b)
- `tests/integration/helpers/testServer.ts` — Wired `StatsService` into `GameService` construction, added `/stats` route registration (LLD 7b)
- `tests/service/gameService.test.ts` — Updated all `GameService` instantiations to pass a mock `StatsService` (LLD 7b)

- `src/frontend/styles/flows.css` — Shared CSS classes for pre-game flow screens: `.flow-page`, `.form-card`, `.btn-primary`, `.btn-secondary`, and supporting element classes (LLD 6.7)
- `e2e/flows.spec.ts` — 15 E2E Playwright tests for pre-game flows: login (3 tests), signup (2), home page (2), create game (3), join game (2), navigation/app shell (3) (LLD 6.7)
- `loginViaUI` and `signupViaUI` helper functions in `e2e/helpers/game-helpers.ts` (LLD 6.7)

### Changed

- `src/frontend/styles/game-variables.css` — Extended with form/input/button/layout/error/link CSS custom property tokens (LLD 6.7)
- `src/frontend/index.html` — Body background changed from `#e2e2e2` to `#0d0d0d` to prevent light-flash on initial page load (LLD 6.7)
- `src/frontend/main.ts` — Globally imports `game-variables.css` and `flows.css` (LLD 6.7)
- `src/frontend/component/App.vue` — Rewritten: dark-themed auth-aware nav bar showing user display name and logout button when authenticated; nav hidden on `/game/:gameId` routes; removed debug route display and dead links (LLD 6.7)
- `src/frontend/component/LoginView.vue` — Restyled with `.flow-page`/`.form-card` pattern; added `loading` state, improved error handling using Supabase error messages, new `data-testid` attributes (LLD 6.7)
- `src/frontend/component/SignupView.vue` — Restyled with `.flow-page`/`.form-card` pattern; added `loading` state, `minlength`/`maxlength` constraints, new `data-testid` attributes; preserved guest-session-claiming logic (LLD 6.7)
- `src/frontend/component/HomeView.vue` — Restyled with branded hero layout; shows Create/Join actions for authenticated users and login/signup prompt for unauthenticated users; removed "Load Game" link (LLD 6.7)
- `src/frontend/component/CreateGameView.vue` — Restyled with `.flow-page`/`.form-card` pattern; removed Tonk option and `numberOfDecks` field; added `loading` state and error display; submit disabled until game type selected (LLD 6.7)
- `src/frontend/component/JoinGameView.vue` — Restyled with `.flow-page`/`.form-card` pattern; added `loading` state; submit disabled when input is empty; new `data-testid` attributes (LLD 6.7)
- `src/frontend/routes.ts` — Removed `LoadGameView` route (LLD 6.7)

### Removed

- `src/frontend/component/LoadGameView.vue` — Dead code with no CX flow; removed per LLD 6.7

- `playwright.config.ts` — E2E test infrastructure (LLD 6.6): Playwright config targeting Chromium with `webServer` auto-start for backend (`node build/backend/index.js`) and Vite dev server; serial execution (`workers: 1`) for multiplayer test isolation; global setup project for auth fixture creation
- `e2e/global-setup.ts` — Creates 4 test users via Supabase admin SDK, signs them in programmatically, writes session tokens to `e2e/.auth/playerN.json` storage state files (no browser opened during setup)
- `e2e/helpers/game-helpers.ts` — Page interaction helpers: `createGame`, `joinAsGuest`, `joinAsRegistered`, `waitForGameBoard`
- `e2e/helpers/wait-for-app.ts` — Health check polling utility that polls `/echo` until backend is ready
- `e2e/example.spec.ts` — Smoke tests: authenticated home page load and guest entry screen render
- `vite.config.js` — Added `server.proxy` for `/api` and `/socket.io` routing to backend on port 3000 (replaces nginx for E2E runs)
- `package.json` — Added `test:e2e`, `test:e2e:ui`, and `test:e2e:debug` scripts
- `.gitignore` — Added `e2e/.auth/` to prevent session token files from being committed
- `.github/workflows/ci.yml` — Added `e2e-tests` job: starts Supabase, exports env vars, installs Chromium, builds, runs Playwright
- `data-testid` attributes added to 17 elements across 7 frontend components: `LoginView.vue` (email-input, password-input, login-button), `HomeView.vue` (create-game-link, join-game-link, welcome-message), `CreateGameView.vue` (game-type-select, max-players-input, submit-create-game), `GuestEntryView.vue` (guest-entry, guest-name-input, guest-join-button), `GameLobbyView.vue` (game-lobby, start-game-button, copy-invite-button), `GameBoard.vue` (game-board), `GameOverView.vue` (game-over)

- `tests/integration/` — Integration test suite (LLD 6.5): 13 tests covering auth JWT verification, game CRUD REST flows, and full WebSocket game play. Boots a real server against local Supabase; exercises ES256 JWT verification end-to-end
- `tests/integration/helpers/supabaseUser.ts` — creates real Supabase users and returns ES256 JWTs via GoTrue signUp flow
- `tests/integration/helpers/testServer.ts` — boots a fully-wired Express + Socket.IO server on an ephemeral port; waits for JWKS key to be cached before returning
- `tests/integration/helpers/socketClient.ts` — typed Socket.IO client factory for WebSocket test connections
- `tests/integration/helpers/guestUser.ts` — creates guest sessions via POST /guest/session
- `tests/integration/helpers/setupEnv.ts` — Vitest setupFile that sets integration env vars before any module imports
- `vitest.integration.config.ts` — separate Vitest config for integration tests (30s timeout, single worker, setupFiles)
- `docker-compose.test.yml` — backend + Supabase only (for CI parity checks)
- `.github/workflows/ci.yml` — added `integration-tests` job that starts Supabase via `supabase/setup-cli` and runs `npm run test:integration`
- `package.json` — added `test:integration` and `test:all` scripts

### Fixed

- `src/backend/websocket/socketAuth.ts` — added ES256 verification path (mirrors HTTP auth middleware); was previously HS256-only, causing WebSocket connections with real Supabase-issued ES256 tokens to fail; uses `getCachedJwksKey()` from `authMiddleware.ts` to avoid duplicating JWKS fetch logic
- `src/backend/middleware/authMiddleware.ts` — exported `getCachedJwksKey()` to allow `socketAuth.ts` to share the cached JWKS public key

- `tests/frontend/useCardSelection.test.ts` — 16 tests for `useCardSelection`: initial state, toggle (select, deselect, multi-select, isolation), `selectedCards` ordering and reactivity, out-of-range filtering, `clearSelection`, and `selectionCount` sequencing
- `tests/frontend/useGameState.test.ts` — 14 tests for `useGameState`: initial state, `bind` registers listener, state/status/initialized updates from `game:state` events, sequential event updates, `unbind` removes listener and stops processing, safety of calling `unbind` before/multiple times, readonly enforcement
- `tests/frontend/useGameActions.test.ts` — 28 tests for `useGameActions`: initial state, pre-bind rejection for all three actions, post-unbind rejection, `startGame`/`playCards`/`pass` emit correct events, success/failure responses, actionError fallback messages, error clearing, actionPending reset

### Fixed

- `src/backend/middleware/authMiddleware.ts` — updated Supabase JWT verification to support ES256 tokens signed with an ECDSA key; fetches and caches the public key from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` at startup, falls back to HS256 with the shared secret when `SUPABASE_URL` is not set; guest tokens are unaffected
- `src/frontend/component/game/GameLobbyView.vue` — removed dead `socket: TypedClientSocket | null` prop and its unused `TypedClientSocket` import; the prop was never passed from `GameView.vue` and never used inside the component
- `src/frontend/component/game-ui/GameCard.vue` — added `.card__corner` element (top-left rank + suit labels) matching the approved mockup; added `interactive?: boolean` prop used for `cursor: pointer` styling
- `src/frontend/component/game/GameBoard.vue` — replaced flat `var(--felt)` background with radial gradient, SVG dot-pattern texture overlay (`::before`), and 12px wood-grain rim border-image (`::after`); changed to `position: fixed; inset: 0` to escape the `#app` width constraint
- `src/frontend/component/game-ui/PlayArea.vue` — added `@keyframes glow` pulsing box-shadow animation on the turn banner when it is the current player's turn
- `src/frontend/component/game-ui/OpponentRow.vue` — added `@keyframes pulse` scale/opacity animation on the active opponent dot; removed unused `index` variable from `v-for`
- `src/frontend/index.html` — removed `#app { width: 80%; margin: auto; }` which constrained the game board width
- `src/backend/api/game/joinGame.ts` — added `deduplicateDisplayName` function; new players are assigned a deduplicated display name (e.g. "Alex" → "Alex 2") if their requested name already exists in the game

---

## [2026-06-07] — Implement Guest Access (LLD 5)

### Added

- `src/backend/guest/guestToken.ts` — `createGuestToken` and `verifyGuestToken`: HMAC-SHA256 signed guest tokens with format `"guest:" + base64url(guestId.gameId.expiresAt.hmac)`
- `src/backend/guest/guestSessionStore.ts` — `GuestSessionStore` class: in-memory Map with TTL, `create`, `get`, `delete`, `getByGame`, `startCleanupLoop`, `stopCleanupLoop`. Not a singleton — instantiated in `server.ts` and injected.
- `src/backend/guest/types.ts` — `GuestSession` interface (server-side session record)
- `src/shared/guest-types.ts` — Shared request/response types: `CreateGuestSessionRequest`, `CreateGuestSessionResponse`, `ClaimGuestSessionRequest`, `ClaimGuestSessionResponse`
- `src/backend/api/guest/createSession.ts` — `POST /guest/session` handler: validates game exists (404 if not), validates display name (non-empty, max 20 chars), deduplicates name within game, creates session, returns signed token
- `src/backend/api/guest/claimSession.ts` — `POST /guest/claim` handler: verifies guest token, swaps `guestId` → `newUserId` in `Game.playerIds` and `Game.playerDisplayNames`, returns `gamesLinked` count
- `src/frontend/service/guestService.ts` — `createGuestSession`, `restoreGuestSession`, `getGuestToken`, `clearGuestSession`, `claimGuestSession`: cookie-based guest session management with client-side token decode for page refresh
- `src/frontend/component/GuestEntryView.vue` — Guest entry screen: display name input, Join Game button, Sign in / Sign up links, error display
- `tests/guest/guestToken.test.ts` — 9 tests: token format, base64url decodability, payload fields, valid decode, tampered HMAC rejected, expired rejected, wrong secret rejected, malformed token rejected
- `tests/guest/guestSessionStore.test.ts` — 14 tests: create fields, UUID format, uniqueness, get happy path, get null for unknown/expired, delete, getByGame filtering, cleanup loop
- `tests/guest/authMiddlewareDualPath.test.ts` — 10 tests: Supabase JWT regression, guest token accept/reject paths, evicted session rejection, `registeredOnlyMiddleware` allow/deny
- `tests/guest/socketAuthDualPath.test.ts` — 5 tests: Supabase JWT regression, guest token accept/reject paths for Socket.IO
- `tests/api/guest/createSession.test.ts` — 9 tests: happy path (response fields, token verifiable, session stored), deduplication (append suffix, increment until unique), validation (empty name, too long, missing gameId, game not found)
- `tests/api/guest/claimSession.test.ts` — 7 tests: ID swap, display name move, expired token no-op, game not found no-op, guest not in game no-op, missing/invalid token 400

### Changed

- `src/backend/middleware/authMiddleware.ts` — Refactored to `createAuthMiddleware(guestSessionStore)` factory (dual-path: `"guest:"` prefix → guest path, else Supabase JWT). Kept `authMiddleware` as a backwards-compatible export using a null store. Added `registeredOnlyMiddleware` (throws 403 for guests).
- `src/backend/websocket/socketAuth.ts` — Refactored to `createSocketAuthMiddleware(guestSessionStore)` factory (same dual-path logic). Kept `socketAuthMiddleware` backwards-compatible export.
- `src/backend/websocket/types.ts` — Added `isGuest: boolean` to `SocketData`. Updated `SocketAuthPayload` comment to document guest token format.
- `src/backend/util/types.ts` — Added `isGuest?: boolean` to `Request` type extension.
- `src/backend/server.ts` — Instantiates `GuestSessionStore`, starts cleanup loop, wires `createAuthMiddleware` and `createSocketAuthMiddleware` with the store. Registers `/guest/session` (no auth) and `/guest/claim` (Supabase JWT + registeredOnly). Adds `registeredOnlyMiddleware` to `POST /createGame`. Calls `stopCleanupLoop()` on close.
- `src/frontend/routes.ts` — Added `/game/:gameId/join` route for `GuestEntryView`. Changed `/game/:gameId` to `requiresAuth: false`. Route guard redirects unauthenticated users with no guest token to `/game/:gameId/join`.
- `src/frontend/composables/useSocket.ts` — `connect()` tries `getAccessToken()` first, falls back to `getGuestToken()`.

---

## [2026-06-06] — Fix host display name never stored on game creation

### Fixed

- `createGame` now passes the creator's display name to `gameRepo.createGame`, so the host is no longer shown as "Player 1" at game start
- `GameRepository.createGame` and `PostgresDB.createGame` updated to accept and persist `creatorDisplayName` in `playerDisplayNames`
- `joinGame` duplicate-join path now saves the display name if it is missing, so hosts who created games before this fix get their name populated on next join

---

## [2026-06-06] — Fix WebSocket Layer bugs and add unit tests (LLD 3 follow-up)

### Fixed

- `handleGameLeave` in `socketHandler.ts` now checks `!connectionManager.isPlayerConnected()` before emitting `game:playerDisconnected`, preventing false disconnect notifications when a player has multiple tabs open
- Removed dead `if (!socket.recovered)` empty block from `registerSocketHandlers`
- Spectator join rejection now always blocks a player from joining their own game as a spectator regardless of game capacity (condition simplified to `game.playerIds.includes(userId)`)

### Added

- `tests/websocket/connectionManager.test.ts` — 16 tests covering addPlayerSocket, removeSocket, isPlayerConnected, multi-tab sockets, getPlayerSockets, spectator tracking
- `tests/websocket/socketAuth.test.ts` — 12 tests covering missing token, invalid JWT, expired JWT, wrong role, and valid token success path (userId/displayName extraction)
- `tests/service/gameService.test.ts` — 14 tests covering getGameState (cache hit, DB fallback, null cases), startGame (success, GAME_NOT_FOUND, GAME_ALREADY_STARTED, NOT_HOST, NOT_ENOUGH_PLAYERS), applyAction (valid, invalid, missing state), getPlayerView (success, null, information hiding)

---

## [2026-06-06] — Implement Big2 Engine (LLD 4)

### Added

- `src/backend/engine/big2/constants.ts` — `SUIT_ORDER`, `RANK_ORDER`, `rankValue`, `suitValue`, `compareCards`, `THREE_OF_CLUBS`, `FULL_DECK`, `PLACEMENT_POINTS`
- `src/backend/engine/big2/hand-types.ts` — `HandType` discriminated union, `FIVE_CARD_HIERARCHY`, `HAND_SIZE`
- `src/backend/engine/big2/big2-types.ts` — `Big2State`, `Big2Play`, `Big2HistoryEntry`, `Big2PlayCardsAction`, `Big2PassAction`, `Big2Action`, `Big2PublicState`
- `src/backend/engine/big2/hand-detection.ts` — `detectHandType`: single, pair, straight, full house, four-of-a-kind, straight flush; rejects triples, 4-card hands, straights containing 2
- `src/backend/engine/big2/hand-comparison.ts` — `beats`: same-category and cross-category (straight < fullHouse < fourOfAKind < straightFlush) comparison
- `src/backend/engine/big2/scoring.ts` — `computeScores`: placement-based points (5/3/1/0 for 4P, 5/3/0 for 3P, 5/0 for 2P)
- `src/backend/engine/big2/deck.ts` — `buildDeck`: shuffles via PRNG, deals per player count (4P: 13 each, 3P: 17 each with 3♣ removed, 2P: 13 each), finds lowest dealt card
- `src/backend/engine/big2/valid-actions.ts` — `computeValidActions`, `isValidPlay`, `canBeatLastPlay`: full validation including first-play lowest-card requirement, card-count matching, hand comparison
- `src/backend/engine/big2/big2-engine.ts` — `Big2Engine` implementing `GameEngine`: initialize, applyAction, getPlayerView, getValidActions, getSpectatorView, isGameOver; handles game completion, player finishing, trick resets, turn skipping for finished players
- `tests/engine/big2/hand-detection.test.ts` — 18 tests covering all hand types and rejection cases
- `tests/engine/big2/hand-comparison.test.ts` — 20 tests covering same-category and cross-category comparisons
- `tests/engine/big2/valid-actions.test.ts` — 18 tests: computeValidActions, isValidPlay, canBeatLastPlay
- `tests/engine/big2/scoring.test.ts` — 10 tests: correct placement points for 2P/3P/4P, breakdown field
- `tests/engine/big2/game-flow.test.ts` — 22 tests: initialization, turn advancement, trick reset, rejection cases, immutability, finished player handling
- `tests/engine/big2/information-hiding.test.ts` — 11 tests: PlayerView never exposes other players' hands, SpectatorView has no hands or validActions
- `tests/engine/big2/full-game.test.ts` — 14 tests: complete 2P/3P/4P game simulation with seeded PRNG, invariant checks (version, finishedPlayerIndices monotonicity, currentPlayer never finished), 20-seed random strategy runs

### Changed

- `src/backend/engine/game-engine-factory.ts` — Added `engineFactory` singleton with `Big2Engine` pre-registered

---

## [2026-06-06] — Add Phase 2 LLDs (WebSocket Layer, Big2 Engine)

### Added

- `docs/lld/03-websocket-layer.md` — LLD for Socket.IO integration, room management, and real-time game communication
- `docs/lld/04-big2-engine.md` — LLD for Big2 rules engine implementing the GameEngine interface

### Changed

- `docs/execution-plan.md` — Updated Big2 straights rule (A is high only) and scoring (placement-based 5/3/1/0)

---

## [2026-06-06] — Fix all ESLint errors (lint:check now passes)

### Fixed

- `eslint.config.mjs` — added `argsIgnorePattern: "^_"` so `_`-prefixed unused parameters are ignored; fixes `handler.ts`, `serveAsset.ts`, `serializer.ts`, `routes.ts`
- `src/backend/util/errors.ts` — changed `instanceOfErrorWithStatus` parameter from `any` to `unknown` with proper `typeof`/null guards
- `src/backend/util/types.ts` — changed default generic to `unknown`; added inline eslint-disable for the unavoidable Express `any` in type params
- `src/shared/model.ts` — replaced empty `interface SerializableGameState {}` with `type SerializableGameState = Record<string, unknown>` to satisfy `no-empty-object-type`
- `src/frontend/component/LoadGameView.vue` — added placeholder `<div>` to satisfy `vue/valid-template-root` (empty template is invalid)
- `src/frontend/component/CreateGameView.vue` — replaced `defineProps` + direct prop mutation with local `ref`s; removes `vue/no-mutating-props` violations
- `src/frontend/component/JoinGameView.vue` — same pattern as CreateGameView
- `src/frontend/component/LoginView.vue` — same pattern as CreateGameView
- `src/frontend/component/SignupView.vue` — same pattern as CreateGameView

---

## [2026-06-06] — Supabase Migration (LLD 1)

### Added

- `src/backend/middleware/authMiddleware.ts` — Supabase JWT verification middleware (HS256, `SUPABASE_JWT_SECRET`); extracts `userId` and `displayName` from JWT claims
- `src/backend/database/entities/Game.ts` — Redesigned Game entity: UUID PK, JSONB state, version column (optimistic locking), timestamps
- `src/backend/database/entities/PlayerStats.ts` — New PlayerStats entity for per-user win/loss/score tracking
- `src/backend/database/index.ts` — Barrel exporting `gameRepo` and `statsRepo` singletons (consumers import from here, never from `PostgresDB` directly)
- `src/frontend/service/authService.ts` — Supabase JS SDK wrapper: `signUp`, `signIn`, `signOut`, `getSession`, `getAccessToken`
- `supabase/config.toml` — Supabase local project config (port 54321/54322, email confirmation disabled for dev)
- `supabase/seed.sql` — Seed template for local development
- `.env.example` — All required environment variables documented with descriptions
- `.env.local` — Local development env template (git-ignored)
- `tests/middleware/authMiddleware.test.ts` — 14 unit tests: missing token, invalid token, wrong secret, expired token, wrong algorithm, anon role rejection, valid token extraction, displayName fallback, next() invocation

### Changed

- `src/backend/database/database.ts` — Replaced `Database` interface with `GameRepository` + `PlayerStatsRepository` interfaces; removed all auth methods; imports `GameType` from `@shared/engine-types`
- `src/backend/database/postgres.ts` — Removed all auth methods; updated entity list to `[Game, PlayerStats]`; updated connection config to use Supabase env vars (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`); default port 54322 (Supabase local); `saveGame` uses optimistic locking (transaction + version check)
- `src/backend/server.ts` — Removed auth routes (`/auth/*`), SSE route (`/event`), `/authNedEcho`; replaced `authNHandler` with `authMiddleware`; removed `cookieParser` middleware
- `src/backend/util/types.ts` — Renamed `accountId` → `userId`; added `displayName` on Request type
- `src/backend/api/game/createGame.ts` — Uses `req.userId`, `gameRepo` from barrel, `crypto.randomUUID()` for game ID generation
- `src/backend/api/game/joinGame.ts` — Uses `req.userId`, `gameRepo` from barrel
- `src/backend/api/game/getGameState.ts` — Uses `req.userId` from JWT (removed redundant `userId` query param); `gameRepo` from barrel
- `src/backend/util/serializer.ts` — Takes typed `Game` entity instead of `ObjectLiteral`; fixed state cast to `SerializableGameState`; `accountIds` → `playerIds`
- `src/shared/model.ts` — Removed all auth interfaces; `accountIds` → `playerIds` on `SerializableGame`; `numPlayers` → `maxPlayers` on `CreateGameRequest`; removed `userId` from `GetGameStateRequest`
- `src/frontend/main.ts` — Replaced cookie-based auth header with Supabase axios interceptor
- `src/frontend/routes.ts` — Auth guard uses `getSession()` from Supabase instead of JWT cookie
- `src/frontend/component/LoginView.vue` — Uses `signIn()` from authService; email-based login
- `src/frontend/component/SignupView.vue` — Uses `signUp()` from authService; email + displayName fields
- `src/frontend/component/HomeView.vue` — Uses `getSession()` from authService for auth check
- `src/frontend/component/CreateGameView.vue` — `numPlayers` → `maxPlayers`
- `src/frontend/component/game/GameView.vue` — Uses `getSession()` for userId; removed `BatchGetUsername` calls
- `src/frontend/component/game/GameLobbyView.vue` — Uses `playerIds` from game state; removed SSE and `BatchGetUsername`
- `src/frontend/tsconfig.json` — Added `"module": "ESNext"`, `"moduleResolution": "bundler"`, `types: ["vite/client"]` to support `import.meta.env`
- `docker-compose.yml` — Removed standalone `database` service; Supabase local stack provides Postgres
- `.gitignore` — Added `.env.local` and `supabase/.temp/`
- `vitest.config.ts` — Added `@` path alias pointing to `src/backend` (required for middleware tests)

### Removed

- `src/backend/api/auth/getNonce.ts` — Nonce flow eliminated
- `src/backend/api/auth/createAccount.ts` — Supabase handles account creation
- `src/backend/api/auth/getAuthToken.ts` — Supabase handles sign-in
- `src/backend/api/auth/batchGetUsername.ts` — User info comes from Supabase JWT
- `src/backend/api/event.ts` — SSE handler (replaced by Socket.IO in LLD 3)
- `src/backend/service/authNService.ts` — Custom JWT signing/verification eliminated
- `src/backend/middleware/authNHandler.ts` — Replaced by `authMiddleware.ts`
- `src/backend/database/entities.ts` — Entities moved to `entities/` directory
- `src/backend/database/subscribers.ts` — Both subscribers reference deleted entities/systems
- `src/shared/crypto.ts` — AES encrypt/decrypt only used by nonce auth flow
- `src/frontend/service/authNService.ts` — Replaced by `authService.ts`
- `src/frontend/util/cookie.ts` — JWT cookie management replaced by Supabase SDK
- `src/frontend/util/sse.ts` — SSE utility (replaced by Socket.IO in LLD 3)
- `argon2`, `crypto-js`, `@types/crypto-js`, `cookie-parser`, `@types/cookie-parser` npm packages

---

## [2026-06-03] — Implement Game Engine Interface (LLD 2)

### Added

- `src/shared/engine-types.ts` — All shared engine types: `Card`, `Suit`, `Rank`, `GameAction`, `ValidAction`, `ActionResult`, `InternalGameState`, `PlayerView`, `PlayerPublicInfo`, `PlayerPrivateInfo`, `SpectatorView`, `GameStatus`, `GameType`, `PlayerId`, `PlayerInfo`, `PlayerScore`
- `src/backend/engine/game-engine.ts` — `GameEngine` interface and `GameEngineConfig` type
- `src/backend/engine/game-engine-factory.ts` — `GameEngineFactory` class (register, getEngine, hasEngine, getRegisteredTypes)
- `src/backend/engine/game-cache.ts` — `GameCache` class with eviction by inactivity and capacity overflow; `GameCacheEntry` and `GameCacheConfig` types
- `src/backend/engine/prng.ts` — `PRNG` interface, `SeededPRNG` (mulberry32), `FixedPRNG` (test helper), `generateSeed` (crypto.randomBytes), `hashSeed` (djb2)
- `tests/engine/prng.test.ts` — 21 tests: determinism, bounds, shuffle correctness, FixedPRNG sequence and wrap-around
- `tests/engine/game-cache.test.ts` — 21 tests: get/set/update/markClean/evict/has/getDirtyEntries, capacity overflow, inactivity eviction (fake timers), eviction loop lifecycle
- `tests/engine/game-engine-factory.test.ts` — 14 tests: registration, retrieval, duplicate rejection, missing engine error, hasEngine, getRegisteredTypes
- `vitest.config.ts` — Vitest configuration with `@shared` path alias

### Changed

- `src/shared/model.ts` — `GameType` and `GameStatus` now re-exported from `engine-types.ts`; removed `"PAUSED"` status
- `package.json` — `test` script now runs `vitest run`; added `vitest` dev dependency

---

## [2026-06-03] — Add changelog pre-commit hook

### Added

- `.githooks/pre-commit` — rejects commits without CHANGELOG.md staged
- `.claude/settings.json` — Claude Code hook warns before committing without changelog
- `postinstall` script in `package.json` — auto-configures `core.hooksPath` on `npm install`

---

## [2026-06-03] — Add Phase 1 LLDs (Supabase Migration, Game Engine Interface)

### Added

- `docs/lld/01-supabase-migration.md` — LLD for replacing custom auth + Postgres with Supabase
- `docs/lld/02-game-engine-interface.md` — LLD for the generic game engine interface contract

### Changed

- `DEVELOPMENT.md` — Architect and Design Reviewer now read direct upstream LLDs (per execution plan dependency graph) to ensure cross-doc consistency

---

## [2026-06-03] — Add agent routing table and fix changelog dating

### Added

- Agent routing table in `CLAUDE.md` — maps trigger phrases to correct agent persona
- Explicit commit requirement: changelog entries must be dated `[YYYY-MM-DD]` at commit time

### Fixed

- Changelog date: moved entries from `[Unreleased]` to `[2026-05-30]` to match commit date

---

## [2026-05-30] — Project design docs, development workflow, and agent personas

### Added

- Project design documentation (`docs/`)
  - High-level design doc (`project-hld.md`)
  - Architecture principles (`architecture-principles.md`)
  - Testing principles (`testing-principles.md`)
  - Customer experience flows and wireframes (`customer-experience.md`)
  - Execution plan with 9 LLDs across 6 phases (`execution-plan.md`)
- Agent personas (`.claude/agents/`)
  - CEO — strategic decisions and priorities
  - Architect — writes LLDs
  - Design Reviewer — validates LLDs against principles
  - Implementer — codes against approved LLDs
  - Code Reviewer — reviews implementation correctness and security
  - QA — validates features against CX doc
- `DEVELOPMENT.md` — development workflow guide with persona invocation and communication protocol
- `CHANGELOG.md` — this file

### Changed

- Updated `CLAUDE.md` — slimmed to orientation file, moved commands/conventions to DEVELOPMENT.md

---

<!--
## Entry Template

## [YYYY-MM-DD] — Short title

### Added
- New feature or file

### Changed
- Modification to existing behavior or file

### Fixed
- Bug fix

### Removed
- Deleted code, file, or feature

### Notes
- Context, decisions made, or anything worth calling out
-->
