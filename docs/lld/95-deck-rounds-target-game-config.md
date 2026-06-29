# LLD 95: Add deckRoundsTarget as a typed creator-config field through the backend (API + persisted game-config JSONB + migration)

> Supersedes LLD 93 and reverses LLD 65 §9.9. The "dedicated `deck_rounds_target` INT column" approach (PR #107) is rejected by the product-owner Restart decision on #60. Persistence is now ONE typed JSONB column on `games`, `game_config`. Build fresh from clean `main`; close PR #107 as superseded.

## Scope

In scope — the full backend plumbing so a creator-supplied `deckRoundsTarget` reaches the Tonk engine:

- A typed `GameConfig` interface in `src/shared/model.ts` and a typed `gameConfig: GameConfig` field on `SerializableGame`.
- `CreateGameRequest` carries an UNCHANGED, typed top-level `deckRoundsTarget?: number` (the client does NOT assemble a config blob).
- Range validation `[5, 12]` integer in `createGame.ts`, mirroring the `VALID_TIMER_VALUES` reject-shape. Omitted → accepted, defaults to 8 (do NOT reject when absent).
- A `gameConfig` field on the `Game` entity, threaded through `gameRepo.createGame` / `saveGame` / `mapGame` in `supabaseDb.ts` and the `GameRepository` interface in `database.ts`, mapping to/from a single `game_config` JSONB column.
- `gameService.startGame` reads `game.gameConfig.deckRoundsTarget` and passes `options: { deckRoundsTarget: ... ?? 8 }` into `engine.initialize`, replacing the hardcoded `options: {}`.
- Migration `009_add_game_config.sql` adding the `game_config` JSONB column, its `009_*.postcondition.sql`, and the drift-gate allowlist + fixture coupling updates.

Explicitly NOT in scope:

- Any UI to set `deckRoundsTarget` (later slices of #60).
- Any change to the Tonk engine. The engine's `resolveDeckRoundsTarget` contract (clamp `[5,12]`, default 8) is unchanged (LLD 65 §8.8).
- Migrating `turn_timer_seconds` into the blob — it stays its own existing column (generic, not game-specific).
- Any `player_stats` migration (LLD 66 / #78 territory).
- Reusing the dead `gameOptions: {[k]: string}` bag in `model.ts` (untyped, string-valued, unpersisted — loses numeric typing).

## Approach

Key decisions and rationale:

1. **One generic JSONB column, typed at the application boundary.** `games.game_config JSONB NOT NULL DEFAULT '{}'`. No game-type-specific SQL column. Big2 persists `{}`; Tonk persists `{"deckRoundsTarget": <n>}`. Typing lives in the `GameConfig` TypeScript interface, not in the database. This keeps create/persist plumbing generic (Principle 7, pluggable storage) and lets future game-specific config land additively without schema churn.

2. **Client API shape is unchanged and stays flat.** `CreateGameRequest.deckRoundsTarget?: number` is a top-level typed number, exactly mirroring `turnTimerSeconds`. The backend — not the client — maps the validated value into `game_config` on persist. This preserves the existing client contract and keeps validation server-authoritative (Principle 1).

3. **Validation mirrors the timer precedent, but with a defaulting twist.** `turnTimerSeconds` rejects when absent; `deckRoundsTarget` must NOT — an omitted value is a valid "use the default 8" request (the field is creator-optional and Tonk-only). So: if present, it must be an integer in `[5, 12]` or the request is a `BadRequestError`; if absent, it is accepted and the backend defaults it to 8.

4. **Defense in depth on the default.** The authoritative validation is `createGame.ts`. The engine's `resolveDeckRoundsTarget` independently clamps/defaults (it is reached via `recoverDeckRoundsTarget` on later tricks too), so a malformed persisted value can never crash Tonk. We default to 8 at the service boundary (`?? 8`) AND rely on the engine's own clamp — both layers agree on 8.

5. **A bare `ADD COLUMN IF NOT EXISTS` is drift-immune.** It touches no constraint, so prod's TypeORM-era PK name (`games_pkey1`) is irrelevant. This is why the migration is safe against the prod-shaped fixture. The postcondition asserts SHAPE only (column exists, type is `jsonb`) using the `pg_attribute` / `format_type` pattern from 001–008 — NEVER a constraint name (the LLD 66 §004 failure mode).

## Interfaces / Types

`src/shared/model.ts`:

```ts
// New: typed, persisted game configuration. Generic across game types; fields
// are game-specific and optional. Persisted as the games.game_config JSONB column.
export interface GameConfig {
  // Tonk only: target deck length in rounds, integer [5,12], default 8.
  // Absent for Big2 and for Tonk games created before this field existed.
  deckRoundsTarget?: number;
}

export interface CreateGameRequest {
  gameType: GameType;
  maxPlayers: number;
  gameOptions: { [key: string]: string }; // unchanged dead field; do NOT reuse
  turnTimerSeconds: 30 | 60 | 90;
  deckRoundsTarget?: number; // NEW: optional, integer [5,12]; omitted -> default 8
}

export interface SerializableGame {
  // ...existing fields unchanged...
  turnTimerSeconds: number | null;
  joinCode: string | null;
  gameConfig: GameConfig; // NEW: always present; {} for Big2
}
```

`src/backend/database/entities/Game.ts`:

```ts
export class Game {
  // ...existing fields unchanged...
  gameConfig: GameConfig = {}; // NEW; maps to/from games.game_config JSONB
}
```

`src/backend/database/database.ts` — `GameRepository.createGame` gains a trailing param:

```ts
createGame(
  gameId: string,
  gameType: GameType,
  creatorId: string,
  maxPlayers: number,
  creatorDisplayName: string,
  turnTimerSeconds: number | null,
  joinCode: string | null,
  gameConfig: GameConfig, // NEW (trailing, so the rematch caller can pass {})
): Promise<Game>;
```

`src/backend/api/game/createGame.ts` — validation helper, mirroring `VALID_TIMER_VALUES`:

```ts
const MIN_DECK_ROUNDS = 5;
const MAX_DECK_ROUNDS = 12;
const DEFAULT_DECK_ROUNDS = 8;

// Returns the validated value, or 8 when omitted. Throws BadRequestError when
// present-but-invalid (non-integer, out of [5,12]).
function resolveDeckRoundsTargetOrThrow(raw: number | undefined): number;
```

The handler assembles `gameConfig: GameConfig = { deckRoundsTarget: <validated> }` and passes it into `gameRepo.createGame`.

> Decision — does Big2 store `deckRoundsTarget`? Recommended: store the resolved value for ALL game types (`{ deckRoundsTarget: 8 }` for Big2 when omitted) for uniformity, OR store `{}` for Big2 and only populate for Tonk. The Restart note explicitly states "Big2 stores `{}`". Therefore: only populate `deckRoundsTarget` in `game_config` when `gameType === "tonk"`; Big2's `game_config` is `{}`. This is the single game-type conditional permitted by the Restart guidance ("Big2 create must be unaffected; its game_config is `{}`"). Keep it confined to the handler's config-assembly step, not the generic repo layer.

## State Model

Lifecycle of the value (matches the `turnTimerSeconds` precedent):

1. **Create (HTTP, status `CREATED`).** Client sends `CreateGameRequest` with optional `deckRoundsTarget`. `createGame.ts` validates it, builds `gameConfig` (`{ deckRoundsTarget }` for Tonk, `{}` for Big2), and passes it to `gameRepo.createGame`, which writes the `game_config` JSONB column on the new row.
2. **Persist / round-trip.** `mapGame` reads `row.game_config` (defaulting to `{}` if null/absent) into `Game.gameConfig`. `saveGame` writes `game.gameConfig` back to `game_config` on every update. The value is set once at create and never mutated afterward (immutable like the join code), but `saveGame` must include the column so it is not dropped on the first state update.
3. **Start (`gameService.startGame`).** Reads `game.gameConfig.deckRoundsTarget`, passes `options: { deckRoundsTarget: game.gameConfig.deckRoundsTarget ?? 8 }` into `engine.initialize` (replacing `options: {}` at `service/gameService.ts:102`).
4. **Engine (unchanged).** `TonkEngine.initialize` reads `config.options["deckRoundsTarget"]` via `resolveDeckRoundsTarget` (clamp `[5,12]`, default 8). Later tricks recover the target from deck size — no engine change. Big2's engine ignores `options` entirely.

Persisted vs in-memory:

- **Persisted:** `games.game_config` (JSONB). Durable across restarts; survives `CREATED` → `IN_PROGRESS`.
- **In-memory:** the `Game.gameConfig` object on the loaded entity; and, once started, the value is baked into the engine's `InternalGameState` (deck size). The game-state cache (Principle 5) is unaffected — `game_config` is lobby metadata read at start time, not on the per-action hot path.

`createRematch` reuses the old game's config: pass `oldGame.gameConfig` as the `gameConfig` argument to `createGame` so a rematch preserves the creator's deck length. (This is a one-line addition at the existing `createGame` call in `createRematch`.)

## Edge Cases

1. **`deckRoundsTarget` omitted** → accepted; backend resolves to 8. Tonk gets default-length decks. (NOT rejected — differs from timer.)
2. **`deckRoundsTarget` present but non-integer (e.g. 7.5) or out of `[5,12]`** → `BadRequestError` from `createGame.ts`.
3. **`deckRoundsTarget` present for a Big2 create** → Recommended: ignore it (Big2 `game_config` stays `{}`); the engine never reads it. Do NOT reject — the client may send a benign default. (Validation still runs if present, so an out-of-range value is still a 400 regardless of game type; this keeps validation game-type-agnostic and simple.)
4. **Existing prod rows with no `game_config`** → the column has `DEFAULT '{}'`, so the migration backfills every existing row to `{}`. `mapGame` also coalesces null/undefined → `{}` defensively. No game-type-specific backfill is needed (unlike LLD 66 §004) because `{}` is the correct value for every pre-existing game.
5. **Malformed persisted `game_config` (e.g. `deckRoundsTarget: "eight"`)** → `startGame` passes it through; the engine's `resolveDeckRoundsTarget` rejects non-numbers and falls back to 8. No crash. (Should be unreachable given create-time validation.)
6. **Rematch** → `createRematch` passes `oldGame.gameConfig` through to `createGame`, preserving the configured deck length. (Without this, rematch would silently reset to `{}` / default 8.)
7. **`saveGame` omitting `game_config`** → would drop the configured value to whatever the DB last held; the `update` statement MUST include `game_config: game.gameConfig`.
8. **Drift-gate / fixture coupling (CI trap)** → adding `009_*.sql` to `expectedPending` WITHOUT adding the same filename to `clean-diff.json`'s `pending` array fails the gate with "Stale expectedPending" (it would be in `expectedPending` but not `actualPending`). Both edits are mandatory. `objects` / `expectedFromPending` / `acknowledgedResidual` stay empty (a bare ADD COLUMN produces no residual diff objects against the clean fixture).
9. **Postcondition coverage (CI trap)** → `verify-postconditions.mjs` enforces 1:1 between `NNN_*.sql` and `NNN_*.postcondition.sql`. Shipping `009_add_game_config.sql` WITHOUT `009_add_game_config.postcondition.sql` fails with "COVERAGE FAIL". Both files are mandatory.

## Dependencies

Must already exist (all present on `main`):

- The migration-safety harness from PR #93: `scripts/verify-postconditions.mjs`, `scripts/verify-drift.mjs`, `scripts/lib/drift-gate.mjs`, `supabase/migrations/expected-diff.allowlist.json`, `scripts/fixtures/clean-diff.json`. (Prereq tier cleared — use it.)
- The Tonk engine's `resolveDeckRoundsTarget` / `recoverDeckRoundsTarget` (`src/backend/engine/tonk/deck.ts`) and constants `MIN/MAX/DEFAULT_DECK_ROUNDS_TARGET` (5/12/8). Unchanged.
- Existing `turnTimerSeconds` plumbing (the precedent this mirrors across `model.ts`, `createGame.ts`, `Game.ts`, `database.ts`, `supabaseDb.ts`, `gameService.ts`).

Migration ordering: `main` is at `008`; this ships as `009`. The migration SQL is exactly:

```sql
-- 009: Add the generic game_config JSONB column for creator-configurable,
-- game-specific options (Tonk deckRoundsTarget first). Big2 rows stay '{}'.
-- Bare ADD COLUMN touches no constraint, so it is immune to the TypeORM-era
-- PK-name drift on prod (games_pkey1). Idempotent.
ALTER TABLE games ADD COLUMN IF NOT EXISTS game_config JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Downstream slices of #60 (UI to set the value) depend on this LLD landing first.

Doc updates required as part of this change: amend LLD 65 §8.8 and LLD 93 to record that the JSONB `game_config` approach supersedes §9.9's dedicated-column decision.

## Test Requirements

Unit (no I/O, per testing-principles §1):

- `createGame.ts` validation:
  - omitted `deckRoundsTarget` → resolves to 8, no throw.
  - each boundary value 5 and 12 → accepted.
  - 4 and 13 (out of range) → `BadRequestError`.
  - non-integer (7.5) and non-number → `BadRequestError`.
  - Big2 create with `deckRoundsTarget` omitted → `game_config` is `{}`.
  - Tonk create with `deckRoundsTarget: 10` → `game_config` is `{ deckRoundsTarget: 10 }`.
- `supabaseDb.mapGame`: `game_config` present → mapped onto `Game.gameConfig`; `game_config` null/absent → coalesces to `{}`.
- `gameService.startGame`: asserts the `options` passed into `engine.initialize` carries `deckRoundsTarget` from `game.gameConfig`, and falls back to 8 when `gameConfig.deckRoundsTarget` is absent. (Inject a fake/spy engine factory per testing-principles §5 — extend the real engine interface.)
- `createRematch`: the `gameConfig` of the old game is passed through to the new `createGame` call.

Integration:

- Create-then-start round-trip (against the test DB / repo): create a Tonk game with `deckRoundsTarget: 6`, start it, assert the engine-built deck reflects 6 (e.g. via `trickDeckSize` recovered target == 6), proving the value survives persist → load → start. Use seeded randomness (testing-principles §2).
- Create a Big2 game (no `deckRoundsTarget`) → starts normally, `game_config` is `{}`, Big2 unaffected (regression guard for the Restart constraint).

Migration / safety (the leg that catches the prior failure modes):

- `verify-postconditions.mjs` passes after `009` is applied to the prod-shaped fixture DB (TypeORM-era drift), NOT just a clean `supabase start`. Assert: `games.game_config` exists and its type is `jsonb` (shape only; no constraint name).
- Coverage check: `009_add_game_config.sql` has a matching `009_add_game_config.postcondition.sql` (else `verify-postconditions.mjs` fails "COVERAGE FAIL").
- Drift gate (`evaluateDriftGate` against `clean-diff.json`): passes with `009_*.sql` added to BOTH `expectedPending` (allowlist) AND the fixture's `pending` array; a negative test that omitting it from the fixture's `pending` yields a `staleExpected` failure documents the coupling.
- Idempotency: applying `009` twice is a no-op (relies on `IF NOT EXISTS`).

Security: none specific — no new client-trusted surface beyond the validated, range-checked numeric field; the value never affects information hiding (it only sets deck length, public information).
