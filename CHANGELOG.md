# Changelog

All notable changes to this project. Updated with every commit.

Format: each entry has a date, short description, and category. Most recent first.

---

## [Unreleased]

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
