# Changelog

All notable changes to this project. Updated with every commit.

Format: each entry has a date, short description, and category. Most recent first.

---

## [Unreleased]

### Removed

- **LLD 74: Remove leftover Vue scaffold (HelloWorld / `/echo` route + EchoHandler)** — deleted the unused `npm create vue` echo scaffold end-to-end. Nothing in the live UI linked to it, and `HelloWorld.vue` POSTed to `/api/authNedEcho`, a backend route that no longer existed. Pure dead-code removal; no behavior change for users.
  - `src/frontend/component/HelloWorld.vue` — deleted (the "Vite + Vue 3" greeting card with two echo buttons).
  - `src/backend/api/echo.ts` — deleted (`EchoHandler`).
  - `src/shared/model.ts` — removed the `EchoRequest` / `EchoResponse` interfaces (imported only by the two deleted files).
  - `src/frontend/routes.ts` — removed the `HelloWorld` import and the `{ path: "/echo", meta: { requiresAuth: true } }` route.
  - `src/backend/server.ts` — removed the `EchoHandler` import and the `["/echo", …]` handler-map entry; the seed map is now `new Map<string, Handler>([])` (the conditional `.set("/", …)` and `.forEach` still type-check and run with an initially-empty map).
  - `tests/integration/helpers/testServer.ts` — removed the `EchoHandler` import and the `["/echo", …]` entry, leaving `["/", ServeAppHandler.INSTANCE]` as the sole entry.
  - `tests/frontend/joinRouteGuard.test.ts` — removed the now-unnecessary `vi.mock("@/component/HelloWorld.vue", …)` (routes.ts no longer imports it).
  - `playwright.config.ts` — repointed the backend `webServer` readiness probe from `http://localhost:3000/echo` to the purpose-built `http://localhost:3000/health` (a real `200 GET`), the only consumer of `/echo` as a probe. Verified the full E2E suite still detects the backend as ready.

### Added

- **LLD 93: `deckRoundsTarget` creator-config field through the backend (#60, slice 1 of 4)** — adds a typed, creator-configurable `deckRoundsTarget` end to end (API → persisted `games` column → engine config), mirroring the `turnTimerSeconds` precedent. Foundation slice: the value can now be set at create time and reaches the Tonk engine; no UI to set it yet (later slices). Big2 omits the field and is unaffected.
  - `src/shared/model.ts` — `CreateGameRequest.deckRoundsTarget?: number` (Tonk only; integer 5–12, omitted → engine default 8) and `SerializableGame.deckRoundsTarget: number | null` (mirrors `turnTimerSeconds: number | null` — the persisted shape always carries the key).
  - `src/backend/api/game/createGame.ts` — authoritative API-boundary validation: rejects present-but-invalid values (non-integer, out of `[5,12]`, `NaN`/`Infinity`/string) with `400`; omitted/explicit-`null` is accepted and forwarded as `null`. Threads the value through `createGameWithCode` → `gameRepo.createGame`.
  - `src/backend/database/entities/Game.ts`, `database.ts`, `supabaseDb.ts` — new nullable `deckRoundsTarget` field/column. `GameRepository.createGame` gains a `deckRoundsTarget` parameter positioned before `joinCode` (so `joinCode` stays last); `createGame`/`saveGame` write `deck_rounds_target` and `mapGame` reads it (NULL → `null`).
  - `src/backend/service/gameService.ts` — `startGame` now builds `config.options = { deckRoundsTarget: game.deckRoundsTarget ?? 8 }` (was hardcoded `{}`); the `?? 8` coalesces "creator did not choose" (NULL) to the engine default `DEFAULT_DECK_ROUNDS_TARGET`. `createRematch` carries the original `oldGame.deckRoundsTarget` into the new game (Edge Case §7). The Tonk engine re-clamps; Big2 ignores `options`.
  - `src/backend/util/serializer.ts` — `serializeGameForPlayer` populates the now-required `deckRoundsTarget` on `SerializableGame`.
  - `supabase/migrations/009_add_games_deck_rounds_target.sql` + co-located `postconditions/009_*.postcondition.sql` — additive, nullable `ALTER TABLE games ADD COLUMN IF NOT EXISTS deck_rounds_target INT`. Name-agnostic (touches no constraint, so prod's `games_pkey1` drift is irrelevant) and re-runnable; the shape-based post-condition asserts column presence + integer type via `search_path`, never a constraint name. `expected-diff.allowlist.json` adds `009_...` to `expectedPending` (removed in a later cleanup once prod is pushed). Live-prod `db push` remains a gated, human-owned release step.
  - Tests: `tests/api/createGame.test.ts` (boundary 5/12, mid-range, omitted/null accepted, below/above range + non-integer + string/NaN/Infinity rejected; `joinCode` assertion moved to `args[7]`, `deckRoundsTarget` at `args[6]`), `tests/service/gameService.test.ts` (persisted value reaches `config.options`, NULL → 8, Big2 unaffected, rematch carry-over), `tests/database/supabaseDb.test.ts` (`mapGame` maps the column incl. NULL → null), `tests/integration/game-crud.test.ts` (create → getGameState round-trip for a set value and for the omitted → null case), `tests/integration/postcondition-runner.test.ts` (009 runs in the prod-shaped + fresh "all post-conditions pass" suites — proving name-agnosticism — plus a focused 009-resolves and 009-RAISEs-when-column-absent pair).
- **LLD 88: Tonk board read-only rendering (`TonkBoard.vue`)** — a new frontend board, sibling to `GameBoard.vue`, that correctly DISPLAYS server-provided Tonk public state before any action controls (#59) exist. Presentation-only: no engine, transport, shared-type, or generic-plumbing change. Everything rendered comes verbatim from the Tonk public view — no client-side rule computation, no hidden info (the board physically cannot read opponent hands or stock contents).
  - `src/frontend/component/game/TonkBoard.vue` — reuses Big2's four-zone CSS-grid skeleton (opponent rail / center table / hand / right panel) and mobile-drawer pattern; narrows `gameSpecificPublicState` to `TonkPublicState`. The center renders the Tonk piles + phase banner instead of Big2's PlayArea; the `actions` zone holds only a read-only turn/phase status line (no buttons). Renders nothing in the hand zone when there is no local hand (spectator-style contract, E11).
  - `src/frontend/component/game/GameView.vue` — two additive edits to the existing `IN_PROGRESS`/`SHOW_FINAL_PLAY` block: **(a)** dispatch `gameType === "tonk"` → `<TonkBoard>`, else `<GameBoard>`; **(b)** gate the existing Big2 final-play ribbon on `displayPhase === "SHOW_FINAL_PLAY" && gameState.gameType === "big2"` so the "wins!" ribbon never renders over a completing Tonk board (E8). The game-agnostic `displayPhase` watcher is unchanged; a completing Tonk game still routes to the existing `GameOverView` (Tonk-correct GameOver wording/ordering is a flagged follow-up, not in this LLD).
  - `src/frontend/component/game-ui/` new Tonk-only presentational components: `TonkPiles.vue` (face-down stock + count, live discard top with multi-discard `×N` badge and "just played" label, and a separate cyan-ringed `drawableDiscard` slot with "from" label; explicit empty/no-card placeholders for E2/E3), `TonkPhaseBanner.vue` (color-coded discard/draw phase chip + active player + trick number), `TonkSeatRail.vue` (per-opponent count + running-tally chip + pulse-dot + phase tag; card-back fan dropped at ≥6, wraps at ≥7, usable at 8), `TonkTallyPanel.vue` (ranked-ascending tallies with a presentational 150-loss-line progress bar + near-150 warning class), `TonkLog.vue` (renders `TonkLogEntry` — discard counts/cards, draw SOURCE only (drawn card never shown), TONK + trick-end summary), and `TonkHand.vue` (read-only local hand typed `readonly TonkCard[]`, keying jokers by `id` so a 2-deck pool's two jokers stay distinct).
  - `src/frontend/component/game-ui/GameCard.vue` — additive: accepts `Card | TonkCard` and renders a joker as a centered icon glyph (never the literal text "Joker"); the Big2 rank/suit path is unchanged.
  - `src/frontend/component/game-ui/tonkDisplay.ts` — pure display-derivation helpers (phase/turn/trick labels, pile name resolution, seat compact/wrap rules, ranked tallies + loss-line progress, log-line text) shared by the components and their tests; the `150` loss line is documented as a display constant (LLD 65 §5.2), not match-end logic.
  - `src/frontend/styles/game-variables.css` — adds `--tonk-cyan`, `--tonk-phase-discard`, `--tonk-phase-draw`, `--tonk-near-150` tokens.
  - Tests (`tests/frontend/tonk*.test.ts`, node-environment logic tests per the project's no-DOM-mount pattern): `tonkDisplay` (phase/turn/trick labels, pile names incl. trick-1 empties, 3–8 seat compact/wrap + disconnected flag, ranked-ascending tallies + tie order + progress + near-150, joker label never "Joker", log rendering incl. the draw-source-only negative assertion and trick-end summary), `tonkBoardDispatch` (Tonk→TonkBoard / Big2→GameBoard, and the E8 ribbon-gate regression guard — Tonk's transient `SHOW_FINAL_PLAY` renders TonkBoard with the ribbon ABSENT while Big2 still shows it), `tonkBoard` (rendering from a constructed `EnrichedPlayerView`, E1 null-state guard, joker pass-through, E11 spectator no-hand contract, and information-hiding negative assertions on the serialized public view), `tonkGameCard` (joker icon path + Big2 no-regression), `tonkHand` (joker-id keying / no key collisions).
- **LLD 77: Prod migration safety & automation (prerequisite tier + scheduled-tier structure)** — closes the "green CI, broken prod" gap that hid the LLD 66 incident (migration `004` hardcoded a constraint name `player_stats_pkey` that prod carried as the TypeORM-era `player_stats_pkey1`, so the composite PK was silently never applied). Implements the three autonomous-safe legs of the LLD's prerequisite tier plus the gated scheduled-tier workflow *structure*. Credential-free by requirement: no prod link, project ref, connection string, or secret is stored — all live-prod wiring (`supabase link --linked`, `db push`, secret storage) is human-owned (LLD §9).
  - **Prod-shaped fixture (§7)** — `tests/integration/helpers/prodShapedFixture.ts`: `createProdShapedFixture()` generalizes the one-off throwaway-schema pattern (the I4 / 006 tests) into a reusable fixture carrying prod's known TypeORM-era drift. Declarative, toggleable drift (`pkey1ConstraintNames`, `strayAnonWriteGrants`) and `baseline: "typeorm-era" | "fresh"`; runs the REAL migration SQL via `readMigrationSql`; isolated in a throwaway schema with `search_path` set to that schema only (so unqualified table AND function references resolve there, never colliding with the live `public` objects); connects only to the local `supabase start` Postgres via `makePgClient` (fully credential-free).
  - **Post-condition verification (§6)** — `supabase/migrations/postconditions/00{1..6}_*.postcondition.sql`: each migration declares a machine-checkable, name-agnostic, shape-based, idempotent, read-only post-condition that `RAISE`s on violation (e.g. 004/006 assert the `player_stats` PK is exactly the composite `(user_id, game_type)`, never a constraint name). `tests/integration/helpers/postconditionRunner.ts` (`checkCoverage`, `runPostconditions`) asserts 1:1 migration↔post-condition coverage and runs each against a target DB. `scripts/verify-postconditions.mjs` is the scripted, non-skippable, fail-closed CLI replacement for the manual post-apply `SELECT` (exit 1 on any coverage gap or RAISE).
  - **Drift-detection gate (§5)** — `scripts/lib/drift-gate.mjs` (`evaluateDriftGate`): pure, fail-closed diff-subtraction (`residual = observed − expectedFromPending − acknowledgedResidual`) with stale-allowlist detection (an `expectedPending` entry already applied → fail; a pending migration missing from it → fail; an `acknowledgedResidual` that suppresses nothing → fail). `supabase/migrations/expected-diff.allowlist.json` is the version-controlled, reviewable allowlist (both lists empty on this branch — 001–006 are applied). `scripts/verify-drift.mjs` is the CLI: `--diff-file` reads a captured/fixture diff (autonomous/local/CI default, no prod); `--linked` is the human-owned live-prod path. Captured fixtures in `scripts/fixtures/{clean,drifted}-diff.json`.
  - **Scheduled-tier gated workflow structure (§8)** — `.github/workflows/prod-migrate.yml`: a `workflow_dispatch`-only, fail-closed migrate-and-verify job encoding the `drift gate → db push → verify → deploy` ordering, with the backend `deploy-backend` job `needs:` the migrate job so the backend can never deploy ahead of its schema (the §8.3 invariant; the entrypoint-hook alternative is rejected in §8.1). Prod-touching steps are guarded on empty secret references (`SUPABASE_PROJECT_REF` / `SUPABASE_DB_PASSWORD` / `RAILWAY_TOKEN`) so the structure is exercisable with no secrets present.
  - **CI wiring** — `.github/workflows/ci.yml` now runs the drift gate against the fixture diff (unit-tests job) and the post-condition verifier against the local `supabase start` DB (integration-tests job); `package.json` adds `verify:drift` / `verify:postconditions` scripts.
  - Tests: `tests/scripts/drift-gate.test.ts` (9 pure-function unit cases — residual computation, fail-closed, acknowledgedResidual scoping, stale-allowlist detection); `tests/integration/prod-shaped-fixture.test.ts` (7 cases — the headline LLD 66 incident regression: `004` alone against `pkey1` drift leaves a single-column PK and the PK post-condition RAISEs, then `004`+`006` repairs it; drift toggles; isolation); `tests/integration/postcondition-runner.test.ts` (5 cases — 1:1 coverage, release-blocking on RAISE, same `.sql` passes against both prod-shaped and fresh baselines).
  - Scope note: this LLD's design explicitly defers *implementing* the live-prod apply (criterion 4) and sequences #83 (prod drift cleanup) first; #83 and all `--linked` / `db push` / secret wiring are human-owned and untouched here.
- **LLD 69: Tonk game engine** — a new pure, server-authoritative `TonkEngine` implementing the full `GameEngine` interface for the Tonk (Tunk) variant signed off in LLD 65. Backend-only; proves the engine abstraction supports a second game with no rearchitecting. No `Math.random()`, no PRNG threaded into `applyAction` — all inter-trick deck rebuilds + cuts and the end-of-game TRUE-LOSER draw derive deterministic sub-seeds (`hashSeed(randomSeed + ":trick:" + n)` / `":trueloser:" + n`).
  - `src/shared/tonk-types.ts` — public shapes: Tonk-local `TonkCard = Card | TonkJoker` discriminated union (does NOT widen the shared `Card`/`Rank`, so Big2 is untouched), `isJoker` guard, `TonkPublicState`, `TonkLogEntry`, `TonkTrickResult`, action/phase/source literals.
  - `src/backend/engine/tonk/tonk-types.ts` — backend-local `TonkState` (hidden hands/stock, public discard pile + turn-start `drawableDiscard` snapshot, tallies, trick counters, true-loser fields) and the `{ discard, draw, callTonk }` action union; re-exports public shapes.
  - `src/backend/engine/tonk/constants.ts` — `cardValue` (A=1, 2–10=face, J/Q/K=10, Joker=0), `handValue`, threshold/penalty constants, and a deterministic stable `compareTonkCards` order for the auto-timeout tie-break.
  - `src/backend/engine/tonk/deck.ts` — `deckCount` (`ceil(players/5)`, 6+ → 2 decks), the §8.1 unified blind-cut formula driven by `deckRoundsTarget` (clamped [5,12], default 8), per-trick deck build/shuffle/deal, the always-single-54-card TRUE-LOSER draw deck, and `recoverDeckRoundsTarget` (re-derives the match's target from a trick's deck size so subsequent tricks rebuild with the identical cut).
  - `src/backend/engine/tonk/scoring.ts` — `scoreTrick` (Case A strictly-lowest caller, Case B caught/tied caller +30, Case C stock-out lowest +30 with ties each +30) and `resolveMatchEnd` (≥150 detection; single lost → auto TRUE LOSER; multiple → deterministic joker draw from a fresh 54-card deck).
  - `src/backend/engine/tonk/turn.ts` — TONK-gate predicate, next-seat/next-starter selection (highest tally, ties → lowest seat), and the `drawableDiscard` turn-start snapshot computation.
  - `src/backend/engine/tonk/valid-actions.ts` — phase/gate-aware `computeValidActions` (returns action TYPES) and the discard-payload validator (same-rank, in-hand; jokers group only with jokers).
  - `src/backend/engine/tonk/tonk-engine.ts` — the engine class: two-phase turn (`discard` then `draw`) modeled inside `gameSpecificState.turnPhase` with no interface change (turn hands off only after `draw`); draw-from-discard reads the turn-start snapshot, never the live pile top (a player can never draw back their own discard); per-trick reset/per-match carry; match-end populates `winner` (lowest tally, display only) and `scores[].breakdown.{lost,trueLoser,finalTally}` (numeric flags) for the loss-centric stats derivation; `getPlayerView`/`getSpectatorView` physically exclude opponent hands and stock contents (counts only); auto-timeout discards the single highest-value card (never multiples, never TONK) or draws from stock.
  - `src/backend/engine/game-engine-factory.ts` — `engineFactory.register(new TonkEngine())`.
  - Tests (`tests/engine/tonk/`, 120 unit/integration cases): card values, deck build + §8.1 cut worked examples, initialize 3–8 players, turn phases, the drawable-discard snapshot invariant (buried/multiples/self-draw/trick-2 start card), TONK Cases A/B, stock-out Case C, match end + TRUE LOSER, per-trick reset, invalid-action rejection (state unchanged, version not incremented), auto-timeout, information hiding (JSON-serialized negative leakage assertions), and a full-match simulation for 3/4/5/6/8 players asserting card conservation, no deadlock, monotonic tallies, strict version increment, determinism, and exactly one `trueLoser`.
  - Scope note: this engine only *reads* `config.options.deckRoundsTarget` (defaults to 8) and *populates* `breakdown.trueLoser`. The `deckRoundsTarget` creator-config plumbing (API/DB/frontend) and the `StatsService` `breakdown.trueLoser` read are separately tracked (#60) and intentionally untouched here.

### Changed

- **LLD 66: Game-specific player stats (per game type)** — `player_stats` is now keyed per `(user_id, game_type)` instead of globally per `user_id`, so a player's Big2 and Tonk records are tracked independently. Backward-compatible: existing Big2-only rows backfill to `game_type = 'big2'`. Migration-only + backend contract change; no frontend consumer exists today (`GET /stats` is wired server-side only). **The PR is not merged: per LLD §8.3, the prod Supabase migration must be applied before the consuming backend ships — a release-time step the user owns.**
  - `supabase/migrations/004_player_stats_game_type.sql` — adds `game_type VARCHAR(50) NOT NULL DEFAULT 'big2'` (one-shot backfill via the default, then drops the default), and repoints the primary key from `(user_id)` to the composite `(user_id, game_type)`. Idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, guarded composite-PK re-add). Begins with the §8.2 in-migration safety guard: a `DO $$ ... RAISE EXCEPTION ... $$` block that aborts the migration (before any DDL) if any completed non-`big2` game exists, converting the silent mis-attribution hazard into a loud, safe abort.
  - `supabase/migrations/005_increment_stats_rpc_game_type.sql` — drops the old 5-arg `increment_player_stats` and recreates it with a `p_game_type` parameter and the `ON CONFLICT (user_id, game_type)` conflict target. Re-applies `SECURITY DEFINER` + the `REVOKE`/`GRANT` block (a dropped function does not inherit grants).
  - `src/backend/database/entities/PlayerStats.ts` — adds `gameType: GameType` (part of the composite key).
  - `src/backend/database/database.ts` — `PlayerStatsRepository`: `getStats(userId, gameType)`, new `getAllStats(userId)`, and `incrementStats(userId, gameType, delta)`. `StatsDelta` is unchanged (counters stay independent, keeping LLD 65's loss-centric Tonk mapping compatible).
  - `src/backend/database/supabaseDb.ts` — `getStats` filters by `game_type`, new `getAllStats` returns all of a user's per-game rows, `incrementStats` passes `p_game_type`, and `mapPlayerStats` reads `row.game_type`.
  - `src/backend/service/statsService.ts` — sources `gameType` from `state.gameType` (already on `InternalGameState` — no new dependency) and threads it to every `incrementStats` call.
  - `src/shared/model.ts` + `src/backend/api/stats/getStats.ts` — `GetStatsResponse` reshaped from a flat per-user object to `{ userId, games: GameStatsEntry[] }` (one entry per game type played, each with its own `winRate`; `[]` if none). New `GameStatsEntry` type.
  - Tests: `tests/service/statsService.test.ts` (U1–U5: gameType sourced from state, `tonk` mapping, guest-skip, delta shape unchanged, early returns); `tests/integration/player-stats.test.ts` (I1 isolation, I2 composite-key upsert, I3 atomic concurrent, I4 backfill against a self-materialized pre-`004` schema in a throwaway Postgres schema, I5 empty aggregate, I6 single-row read, I7 6-arg RPC works / 5-arg overload gone; A1–A5 read-API reshape incl. A3 recording a `'tonk'` result via the stats path without the Tonk engine); plus `tests/database/supabaseDb.test.ts` and `tests/integration/rls.test.ts` updated for the new signatures.
  - `tests/integration/helpers/pgClient.ts` — new test-only helper: a direct Postgres connection (`pg`, added as a devDependency) for the I4/I7 raw-DDL checks that PostgREST/the Supabase JS client cannot perform.

### Fixed

- **LLD 73: Game over screen does not show final cards played; remove pre-game-over time pressure** — follow-up to LLD 43. The `SHOW_FINAL_PLAY` reveal no longer dims/blurs the whole board (which hid the very cards it was meant to reveal, worst on mobile), no longer auto-advances on a 4-second timer, and the final cards now remain reviewable on the results screen. Frontend-only; no engine, socket, data-model, or backend changes (`lastPlay` already arrives in `gameSpecificPublicState`).
  - `src/frontend/component/game/GameView.vue` — replaced the full-screen `.game-view__final-play-overlay` (`inset: 0`, `rgba(0,0,0,0.6)` fill + `backdrop-filter: blur(2px)`) with a bottom-anchored `.game-view__final-play-ribbon` (`z-index: 101`, own gold-tinted panel + top `--gold-accent` border + upward shadow) so the table — where `PlayArea` renders `lastPlay` — stays fully un-dimmed and un-blurred. Removed the `setTimeout(..., 4000)` auto-advance, the `finalPlayTimerId` ref, all `clearTimeout` branches (watcher, `skipToResults`, `onUnmounted`), and the CSS progress bar + `@keyframes shrink`: the phase now exits only when the user clicks "Continue to Results", so each player can linger as long as they want. Added a `finalPlay` computed (`gameSpecificPublicState.lastPlay ?? null`) passed as `:final-play` to `GameOverView`. Ribbon has a one-shot slide-up entrance (`@keyframes ribbonSlideUp`) disabled under `prefers-reduced-motion`, and stacks vertically on mobile.
  - `src/frontend/component/game/GameOverView.vue` — added an optional additive `finalPlay?: Big2Play | null` prop and a compact, read-only "Final Play" row (rendered only when `finalPlay` is truthy and `cards.length > 0`, so forfeit/no-play endings render no empty box) below the winner headline. Reuses `GameCard` with `size="small"` (non-interactive); shows the hand-type label (inlined `HAND_TYPE_LABELS`, falls back to the raw `handType.kind` when unknown) and "played by {name}" (resolved from `players` by `playerId`, falls back to the id).
  - `tests/frontend/gameOverTransition.test.ts` — updated the transcribed phase logic to the no-timer model: replaced the "after 4000ms advances" test with "SHOW_FINAL_PLAY does NOT auto-advance over time" (advancing fake timers 60s leaves the phase unchanged), dropped the `finalPlayTimerId`/`clearTimeout`/cleanup assertions; kept the `IN_PROGRESS → SHOW_FINAL_PLAY`, `skipToResults → COMPLETED`, reconnect-skips-reveal, `CREATED → IN_PROGRESS`, and `null/CREATED → COMPLETED` cases.
  - `tests/frontend/gameOverFinalPlay.test.ts` — new: transcribes the row's `hasFinalPlay`/`finalPlayLabel`/`finalPlayByName` gating computeds (node-env, no DOM mount, matching the trickPile/gameBoardMobile pattern): row renders with cards, omitted for null / undefined / empty-cards, label falls back to raw kind when unknown, name falls back to playerId when the player is missing.

- **LLD 75: Clean up prod schema drift — TypeORM-era PK names + stray anon write grants** — two forward, idempotent migrations bring prod's `public` schema back in line with the committed migrations, fixing drift inherited from the pre-Supabase TypeORM era. Both are verified no-ops on fresh local/CI databases (where a clean `supabase start` already produces the conventional names and SELECT-only anon grants), so CI never saw the drift. Same root cause as `006`: `001` uses `CREATE TABLE IF NOT EXISTS`, so on prod (tables pre-created by TypeORM `synchronize`) `001` was a no-op and TypeORM's artifacts persisted. No application/behavior change — schema-reconciliation only, metadata-only (no table rewrite, no data movement). **Applied to prod by the existing human `supabase db push` step; this LLD wires no prod credentials.**
  - `supabase/migrations/007_normalize_pk_names.sql` — renames the primary-key constraints on `games` and `feedback` from prod's `*_pkey1` to the conventional `games_pkey` / `feedback_pkey`. Per table, a `DO $$ ... $$` block looks up the **actual** PK constraint name from `pg_constraint` (`contype = 'p'`, never hardcoded) and `ALTER TABLE ... RENAME CONSTRAINT` only when it differs from the conventional name. `RENAME` is metadata-only (preserves the constraint object + backing index — no rewrite, no PK-absent window, no FK breakage). No-op + idempotent where the name is already conventional; the `IS NOT NULL` guard tolerates a table with no PK. `player_stats` is intentionally omitted — `006` already named its PK `player_stats_pkey`. Table names unqualified (resolve via `search_path`, consistent with `004`/`006`).
  - `supabase/migrations/008_revoke_anon_writes.sql` — `REVOKE INSERT, UPDATE, DELETE ON games, player_stats, feedback FROM anon` so the grants match `001`'s declared SELECT-only intent for `anon`; `SELECT` is left intact. This is defense-in-depth, **not** a live-vulnerability fix: RLS (`002`) already blocks every anon write (no INSERT/UPDATE/DELETE policies on `games`/`player_stats`; `feedback`'s insert policy requires `auth.uid() = user_id`, null for anon — proven by `rls.test.ts`). `REVOKE` of an absent grant is a silent no-op, so this is safe/idempotent on fresh DBs. Pre-merge verification (Edge Case 7) confirmed no anon-key write path exists: the backend uses `service_role`, and the frontend anon client (`authService.ts`) is auth-only — `grep` for `supabase.(from|insert|update|delete|upsert|rpc)(` across `src/frontend/` returns nothing.
  - `tests/integration/migration-drift.test.ts` — throwaway-schema integration tests mirroring the `006` harness (each test creates an isolated schema, `SET search_path`, materializes the starting state, runs the **real** migration SQL via `readMigrationSql`, asserts, then drops the schema). `007`: **prod-like games** (`games_pkey1` → `games_pkey`, columns unchanged), **prod-like feedback** (`feedback_pkey1` → `feedback_pkey`), and **fresh-like** (already-conventional names + a no-PK table; run twice; asserts names/columns unchanged and PK OID identical → never dropped/recreated). `008`: **prod-like** (anon granted all four privileges; after `008`, `has_table_privilege('anon', …)` is false for INSERT/UPDATE/DELETE and true for SELECT on all three tables) and **fresh-like** (anon only SELECT; run twice; SELECT stays, writes stay absent).

- **LLD 66: prod composite-PK never applied by `004` (name-fragile DROP)** — `004` step 4 dropped the existing `player_stats` primary key by a hardcoded name (`player_stats_pkey`) and only re-added the composite `(user_id, game_type)` if no PK remained. On fresh local/CI databases the PK is named `player_stats_pkey`, so the swap worked and CI stayed green. But prod's `player_stats` was originally created by TypeORM, where the PK landed as `player_stats_pkey1`; there `004`'s hardcoded `DROP ... IF EXISTS player_stats_pkey` matched nothing and the un-dropped `player_stats_pkey1` kept the re-add guard false, leaving prod with a single-column `PRIMARY KEY (user_id)`. That breaks `005`'s `ON CONFLICT (user_id, game_type)`, so every stats write would error once the 6-arg backend deploys. `004`/`005` are unchanged (already applied to prod and recorded in its migration history; editing them would not re-run).
  - `supabase/migrations/006_fix_player_stats_composite_pk.sql` — repoints the PK to the composite `(user_id, game_type)` by looking up the **actual** PK constraint name dynamically from `pg_constraint` (never hardcoded), so it works whether the existing PK is `player_stats_pkey1` (prod) or `player_stats_pkey` (fresh). Acts only when the PK is not already the correct composite (sorted-column comparison), so it is a no-op on fresh/CI databases where `004` already succeeded; idempotent and re-runnable. Names the new constraint `player_stats_pkey` so prod ends up consistent with fresh databases. Table name unqualified (resolves via `search_path`, consistent with `004` and the throwaway-schema tests).
  - `tests/integration/player-stats.test.ts` — two new throwaway-schema tests (mirroring the I4 harness): **prod-like** materializes a single-column PK named `player_stats_pkey1` (with `game_type` already present, as post-`004` prod) and asserts `006` repoints it to the composite `player_stats_pkey`; **fresh-like** materializes the composite PK already, runs `006` twice, and asserts a no-op (PK constraint OID unchanged → never dropped/recreated) and idempotency.

- **LLD 60: Join-game screen requires excessive scrolling on mobile** — the `/join-game` screen (and every other `.flow-page` screen: login, signup, create-game, home, guest-entry) no longer forces the document taller than the viewport, so short forms fit without vertical scrolling on mobile. Pure CSS layout fix (Option A, flex-fill); no markup, component, or behavior changes.
  - `src/frontend/component/App.vue` — `.app-shell` `min-height: 100vh` → `min-height: 100dvh`, so the shell tracks the visible viewport on mobile as browser chrome shows/hides instead of the chrome-inclusive `100vh` box.
  - `src/frontend/styles/flows.css` — `.flow-page` no longer declares a second `min-height: 100vh`; it is now a flex child (`flex: 1; min-height: 0`) that fills the remaining column space below the nav. This removes the double viewport-height counting that pushed document height to `nav height + 100vh`. `min-height: 0` lets a genuinely tall form (e.g. on-screen keyboard open) still scroll rather than being clipped; the mobile breakpoint top-anchoring block is unchanged.
  - `e2e/mobile-layout.spec.ts` — added a no-overflow assertion: at a 390×844 mobile viewport, `/join-game` renders with `document.scrollingElement.scrollHeight <= window.innerHeight` (reuses the existing Playwright mobile-viewport suite; no new infrastructure).

- **LLD 58: Signed-in home page overflows viewport; content not vertically centered** — the signed-in home page ("Welcome back, $user") no longer adds a stray vertical scrollbar and now centers its content in the visible area below the nav, at both 375×667 and 1440×900. The signed-out home's "Log In" and "Sign Up" buttons now render at equal width.
  - `src/frontend/styles/flows.css` — `.flow-page` changed from `min-height: 100vh` to `flex: 1; min-height: 0` so it fills exactly the leftover height inside the already-flex `.app-shell` column instead of re-asserting a second full viewport height beneath the nav (Option A: no hard-coded nav height). Added a `.flow-page--center` modifier inside the mobile `@media (max-width: 767px)` block so the short home screen centers on mobile while tall forms keep `align-items: flex-start` (top-aligned, scrollable, not clipped).
  - `src/frontend/component/HomeView.vue` — root element now `class="flow-page flow-page--center"`; `.home__btn` gains `width: 100%` plus `box-sizing: border-box` so the primary ("Log In"/"Create Game") and secondary ("Sign Up"/"Join Game") buttons render at the same column width despite the shared button classes' differing `content-box` padding.
    - **Deviation from LLD (flag for code reviewer/architect):** the LLD prescribed only `.home__btn { width: 100%; }` for the button-width fix. That alone equalizes the `content-box` width but not the rendered width — the shared `.btn-primary` (28px) and `.btn-secondary` (20px + 1.5px border) use `content-box` with different horizontal padding, leaving a measured ~14px width difference. Added `box-sizing: border-box` to `.home__btn` to satisfy the LLD's explicit required outcome ("the two buttons are the same width", Visual outcome + Edge case 8). Scoped to `.home__btn` only; the shared `flows.css` button rules are untouched.
  - `e2e/home-layout.spec.ts` — new Playwright specs: no vertical page overflow on `/` signed-in (1440×900, 375×667) and signed-out (1440×900, 375×667); signed-out Log In / Sign Up equal rendered width (within 1px); regression on Login/Signup (no horizontal overflow, form card horizontally centered).

- **LLD 52: Selected cards stay raised after pressing pass; should auto-deselect** — pressing **Pass** now clears the player's card selection, so any raised (`.card--selected`) cards drop back to the resting position in the hand immediately, mirroring the existing deselect-on-successful-play behavior.
  - `src/frontend/component/game/GameView.vue` — `onPass()` now calls `clearSelection()` after `await pass(...)`. The clear is unconditional (unlike `onPlay`'s success-gated clear) because the selection has no functional role in a pass, so a stray selection that survives a pass is exactly the bug.
  - `tests/frontend/gameViewOnPass.test.ts` — 8 unit tests replicating `onPass`/`onPlay` against the real `useCardSelection` composable: selection cleared after pass with one/many cards selected, no-op on empty selection, `pass` called exactly once per invocation, selection cleared even when pass fails (confirms unconditional clear), idempotent on double-press; plus regression tests asserting `onPlay` still clears only on success and not on failure.

- **LLD 48: Game Room ID Not Visible During Gameplay** — the 4-character room (join) code is now shown in-game on the `GameBoard`, anchored to the far-left of the opponents bar, and survives a mid-game refresh/reconnect (when the client loads straight into an `IN_PROGRESS` game and never sees `lobby:state`). Tapping the code copies it to the clipboard, reusing the lobby's copy pattern.
  - `src/shared/socket-events.ts` — added read-only `joinCode: string | null` to `EnrichedPlayerView` (the `game:state` payload); `EnrichedSpectatorView` intentionally unchanged (spectator display out of scope)
  - `src/shared/model.ts` — added `joinCode: string | null` to `SerializableGame` (the REST `getGameState` payload)
  - `src/backend/util/serializer.ts` — `serializeGameForPlayer` now surfaces `game.joinCode`
  - `src/backend/service/gameService.ts` — added `getJoinCode(gameId)`, a read-through cache of the immutable join code, so the per-broadcast hot path resolves the code without an uncached DB read
  - `src/backend/websocket/socketHandler.ts` — join-time `game:state` emit includes `game.joinCode` (row already loaded); `broadcastGameState` includes `joinCode` on the per-player emit via the cached `getJoinCode` (spectator emit unchanged)
  - `src/frontend/component/game-ui/RoomCodeChip.vue` — new component: renders "ROOM CODE" label + code (collapses to "ROOM" on mobile), copies on tap with "Copied!" / "Long-press to copy." feedback, renders nothing when the code is empty/null
  - `src/frontend/component/game/GameBoard.vue` — accepts a `roomCode` prop and renders `RoomCodeChip` in the opponents bar, preferring the live `gameState.joinCode` over the seeded prop
  - `src/frontend/component/game/GameView.vue` — owns a `roomCode` ref seeded from the REST response on mount and kept in sync from `lobby:state`, passed to `GameBoard`
  - **Deviation from LLD (flag for code reviewer/architect):** the LLD prescribed calling `gameService.getGame(gameId)` inside `broadcastGameState`. That call is uncached (unlike the cache-first `getGameState`), adding a real DB round-trip to every broadcast and destabilizing the timing-sensitive abandonment integration tests in `reconnection.test.ts`. Replaced with a read-through `getJoinCode` cache of the immutable code, preserving every LLD invariant (code never in engine state, engine stays pure, every per-player broadcast carries it, spectator payload unchanged, `Game.joinCode` remains the source of truth).
  - Tests: `tests/util/serializer.test.ts` (joinCode present / null), `tests/service/gameService.test.ts` (getJoinCode read/null/missing/memoization/miss-not-cached), `tests/websocket/socketHandler.test.ts` (join-time `game:state` carries joinCode / null), `tests/frontend/roomCodeChip.test.ts` (render gating + copy success/fallback), `tests/frontend/roomCodeReconciliation.test.ts` (GameBoard prefers live joinCode, GameView seeding), `tests/integration/ingame-room-code.test.ts` (join-time + post-action broadcast carry joinCode, REST returns it, spectator payload omits it, no opponent-hand leak)

- **LLD 44: Home Buttons Centering** — "Create Game" and "Join Game" buttons now properly centered on home page across all viewport widths by adding `width: 100%` to `.home` scoped style in `HomeView.vue`


- **LLD 43: Game Over Screen Delay — Show Final Cards Before Transition** — game over screen no longer appears instantly; a 4-second overlay shows the winner announcement while the final played cards remain visible on the board
  - `src/frontend/component/game/GameView.vue` — added `displayPhase` state machine (`CREATED` / `IN_PROGRESS` / `SHOW_FINAL_PLAY` / `COMPLETED`) that decouples rendered view from raw game status; watcher triggers 4s intermediate state on `IN_PROGRESS -> COMPLETED` transition; overlay with winner text, "Continue to Results" button, and animated progress bar; auto-advances after 4s or on user click; skips delay on reconnect to already-completed game
  - `tests/frontend/gameOverTransition.test.ts` — 9 unit tests: phase transitions, timer auto-advance, skip clears timer, reconnect skips delay, cleanup prevents leaks

### Added

- **LLD 67: Restart/Play-again (Rematch) button on the game over screen** — the previously-disabled "Rematch" button is now functional. On the host's click, the server creates a fresh game carrying over the connected players from the finished game, transfers (reuses) the same join code, starts it, and broadcasts the new game id so every connected client navigates straight into the dealt round.
  - `src/shared/socket-events.ts` — added the `game:rematch` client→server event (`GameRematchPayload` / `GameRematchResponse` with `newGameId`), the `game:rematchStarted` server→client broadcast (`GameRematchStartedPayload`), and `GAME_NOT_FINISHED` to the `SocketErrorCode` union.
  - `src/backend/database/database.ts` + `src/backend/database/supabaseDb.ts` — new `GameRepository.clearJoinCode(gameId)` (persists `join_code = NULL`), required to free the code on the old row before inserting the new row, since `saveGame` does not write `join_code` and the partial unique index `idx_games_join_code` blocks a duplicate non-null code at INSERT time.
  - `src/backend/service/gameService.ts` — new `createRematch(oldGameId, requesterId, connectedPlayerIds)`: guards (`GAME_NOT_FOUND`, `GAME_NOT_FINISHED`, `NOT_HOST`, `REMATCH_ALREADY_STARTED` via `joinCode === null`, `NOT_ENOUGH_PLAYERS`), builds the connected-only roster host-first, clears the old code before inserting the new game with the transferred code, mutates `joinCodeCache` on both keys, and reuses `startGame` to deal + persist. Idempotent per finished game (rematch-once).
  - `src/backend/websocket/socketHandler.ts` — new `handleGameRematch` (rejects spectators, computes the connected roster via `connectionManager.getConnectedPlayerIds`, registers/starts the new game's turn timer, broadcasts `game:rematchStarted`, acks `{ success, newGameId }`); registered alongside the other handlers with the standard `INTERNAL_ERROR` catch wrapper.
  - `src/frontend/composables/useGameActions.ts` — added `rematch(gameId)` mirroring `startGame`.
  - `src/frontend/component/game/GameOverView.vue` — replaced the disabled stub with the Option-A states: host active gold-bordered "Rematch" button, non-host passive "Host can start a rematch" pulse-dot indicator, too-few-players disabled hint ("Only you are still here. Need at least 2 players."), inline error ("Couldn't start rematch. Try again."), and a "Dealing a new hand…" pending label; mobile stacked layout preserved.
  - `src/frontend/component/game/GameView.vue` — passes `isHost`/`rematchPending`/`rematchError` to `GameOverView`, handles `@rematch` (calls `rematch`, navigates on success), and listens for `game:rematchStarted` to pull non-host clients into the new game; single-navigation guard for the ack-vs-broadcast race.
  - `src/frontend/component/App.vue` — keyed `<router-view>` by the `/game/:gameId` path so navigating from the old game to the new game id remounts `GameView` and re-runs its join flow (the LLD's "mounts GameView → game:join" step); all other routes share a stable key (no remount-on-navigation change).
  - Tests: `tests/service/gameService.test.ts` (12 `createRematch` unit tests incl. an in-memory repo enforcing the partial-unique-join-code rule — success-from-COMPLETED regression, code transfer + persisted clear, insert-ordering/constraint regression, rematch-once idempotency, cache mutation, host-only, min-2, connected-only host-first roster, not-finished guard, guest carry-over), `tests/frontend/useGameActions.test.ts` (rematch emit/ack/error), `tests/integration/rematch.test.ts` (7 socket tests: host success + broadcast, NOT_HOST, SPECTATOR_CANNOT_ACT, REMATCH_ALREADY_STARTED, new game IN_PROGRESS + transferred code, timer registration, server-authoritative roster), `e2e/rematch.spec.ts` (host active vs non-host passive states, full click-to-navigate flow).

- **LLD 55: Show Previous Played Cards on the Table** — a Big2 trick pile in the table area shows every play (and pass) made during the current trick, so players can review what came before `lastPlay` without opening the log. Collapsed it is a stacked card pile (most recent play on top) with a gold count badge beside the centered current play; clicking/tapping expands an overlay fanning the whole current trick in play order, with passes shown inline. The pile resets when a new trick starts.
  - `src/shared/big2-types.ts` — added `trickStartIndex: number` to `Big2PublicState` (index into `playHistory` where the current trick begins; `currentTrick === playHistory.slice(trickStartIndex)`)
  - `src/backend/engine/big2/big2-types.ts` — added `trickStartIndex` to `Big2State` so it persists/restores inside `gameSpecificState`
  - `src/backend/engine/big2/big2-engine.ts` — engine now owns the trick boundary (the frontend-only derivation was non-deterministic against real `pass→play` mid-trick transitions): `initialize` sets `trickStartIndex: 0`; the `handlePass` trick-close branch advances it to `playHistory.length + 1` (the index the next leader's play will occupy); the `handlePlayCards` branches carry it through unchanged; `getPlayerView`/`getSpectatorView` publish it, coalescing a missing legacy value to `0` (backward compat). It is pure published bookkeeping — never read by the engine to make a decision.
  - `src/frontend/component/game-ui/TrickPile.vue` — new presentational component: derives `currentTrick = playHistory.slice(trickStartIndex)`, renders the stacked pile + gold badge (capped layered cards, most recent on top), and a click-to-expand overlay (Escape/backdrop/close to dismiss); reuses `GameCard`, respects `prefers-reduced-motion`, force-collapses on trick reset, and is mobile-responsive (≥44px tap target)
  - `src/frontend/component/game-ui/PlayArea.vue` — accepts and forwards `playHistory` + `trickStartIndex`; renders `<TrickPile>` beside the centered current play
  - `src/frontend/component/game/GameBoard.vue` — passes `big2State.playHistory` / `big2State.trickStartIndex` into `PlayArea`
  - Tests: `tests/engine/big2/trick-start-index.test.ts` (initial state, plays/non-closing-pass keep the boundary, trick close advances it, the mandatory interleaved `pass→play` fixture, finish-mid-trick, full-game append-only invariant, published in both views, legacy-`undefined` coalesces to `0`); `tests/engine/big2/information-hiding.test.ts` (boundary leaks no hidden data); `tests/frontend/trickPile.test.ts` (derivation, badge count, stack ordering/cap, passes excluded from stack but present expanded, toggle + force-collapse on reset); `tests/integration/websocket-game.test.ts` (boundary invariants across a real driven game); `tests/helpers/seedState.ts` and `tests/engine/big2/game-flow.test.ts` fixtures carry the new field

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
