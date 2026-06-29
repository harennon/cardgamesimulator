# LLD 93: Add `deckRoundsTarget` as a Typed Creator-Config Field Through the Backend

Parent issue: #60 (order 1 of 4). Foundation slice: the field must exist and reach
the Tonk engine before any UI can set it (later slices) or any Tonk game can honor a
non-default deck length.

## Scope

**Covers** the full backend plumbing for a creator-configurable `deckRoundsTarget`,
mirroring the existing `turnTimerSeconds` precedent end to end:

1. Typed `deckRoundsTarget?: number` on `CreateGameRequest` and `SerializableGame`
   (`src/shared/model.ts`).
2. Range validation (5–12) in `createGame.ts`; omitted defaults to 8 and is accepted.
3. A persisted `deckRoundsTarget` column on the `games` table: the `Game` entity, the
   `GameRepository` interface, and `createGame` / `saveGame` / `mapGame` in `supabaseDb.ts`.
4. `gameService.startGame` passes `options: { deckRoundsTarget: game.deckRoundsTarget ?? 8 }`
   into the engine config (currently hardcoded `{}`).
5. A new `games`-table migration (`009_...`) plus its machine-checkable
   `*.postcondition.sql`, tested against the prod-shaped fixture.

**Does NOT cover:**

- Any UI to set `deckRoundsTarget` (later slices of #60).
- Threading the value through the **rematch** path (`createRematch`). See Edge Cases §7 —
  rematch keeps the default for now; carrying it over is explicitly deferred.
- Changing the Tonk engine. `resolveDeckRoundsTarget` already consumes and clamps
  `config.options["deckRoundsTarget"]` (`src/backend/engine/tonk/deck.ts:22`); this LLD
  only makes the value arrive.
- LLD 66's `player_stats` migration work — different table, different PR. Do NOT conflate.
- Live-prod DB push. The migration SQL + postcondition land in a PR; the actual prod
  `supabase db push` is a gated, human-owned release step (LLD 77 §9).

## Approach

### Mirror `turnTimerSeconds`, do not reuse `gameOptions`

`turnTimerSeconds` is the approved precedent for a typed creator-config field that
round-trips create → persist → start → engine. `deckRoundsTarget` follows the same path.

The dead `gameOptions: { [key: string]: string }` bag on `CreateGameRequest` is **not**
reused — LLD 65 §8.8 explicitly prefers a dedicated typed field. (`gameOptions` is also
string-valued and would force lossy number coercion.) A dedicated `number` field gives us
compile-time typing, a single validation site, and a typed DB column.

### Validation policy (differs deliberately from `turnTimerSeconds`)

`turnTimerSeconds` is a closed enum `{30,60,90}` and is **required** (omission → 400).
`deckRoundsTarget` is a **continuous range [5,12]** and is **optional** (omission →
default 8, accepted). Rationale:

- Range, not enum: any integer 5–12 is valid, so validate with bounds + integer check,
  not set membership.
- Optional with default: Big2 ignores the field entirely and existing clients (and all
  current Big2 create calls) omit it. Rejecting omission would break every Big2 create
  path. The default (8) matches the engine's `DEFAULT_DECK_ROUNDS_TARGET`.

The engine's `resolveDeckRoundsTarget` is intentionally redundant (defensive clamp).
This LLD makes `createGame.ts` the **authoritative** validator: out-of-range values are
rejected at the API boundary with 400; the engine clamp remains as defense-in-depth.

### Default lives in one named constant, applied at two layers

- API: reject if present-but-invalid; if absent, leave undefined and let persistence
  store NULL (column is nullable, like `turn_timer_seconds`).
- `startGame`: coalesce `game.deckRoundsTarget ?? 8` when building `config.options`.

Reuse the engine's existing `DEFAULT_DECK_ROUNDS_TARGET = 8` value as the documented
source of truth (do not introduce a second magic 8). The `?? 8` in `startGame` is the
single coalescing site; it should reference the engine constant or a clearly-commented
literal that cites `constants.ts`. Persisting NULL (rather than 8) keeps "creator did not
choose" distinguishable from "creator chose 8" and matches `turn_timer_seconds` nullability.

### Migration: name-agnostic, additive, drift-tolerant

The new migration is `009_add_games_deck_rounds_target.sql`. It is a single additive
`ALTER TABLE games ADD COLUMN IF NOT EXISTS deck_rounds_target INT;`. Key constraints:

- **No constraint names anywhere.** Prod's `games` PK is `games_pkey1` (TypeORM-era drift).
  A bare additive column add touches no constraint, so there is nothing to name — keep it
  that way. This avoids the LLD 66 §004 silent-failure mode (hardcoding `*_pkey` and
  silently no-op'ing on prod's `*_pkey1`).
- **Nullable, no NOT NULL, no DEFAULT backfill needed.** Existing `games` rows (all Big2)
  legitimately have no creator-chosen value; NULL is the correct "unset" state. A NULL on
  start coalesces to 8. This means no backfill abort guard is required (unlike 004).
- **`IF NOT EXISTS`** makes the add re-runnable (matches the 001–008 discipline).
- Column name is snake_case `deck_rounds_target` (mapper convention), type `INT`
  (matches `turn_timer_seconds`).

### Drift-gate allowlist must be updated

`scripts/lib/drift-gate.mjs` fails closed if a pending in-tree migration is **missing**
from `expectedPending` in `supabase/migrations/expected-diff.allowlist.json`. Migration
009 is in-tree but NOT yet applied to prod on this branch, so its filename MUST be added
to `expectedPending`:

```json
"expectedPending": ["009_add_games_deck_rounds_target.sql"]
```

(It is removed from `expectedPending` in a later cleanup once prod is pushed — same
lifecycle the comment in the allowlist describes.) The implementer must update this file;
omitting it makes the drift gate fail.

## Interfaces / Types

### `src/shared/model.ts`

```ts
export interface CreateGameRequest {
  gameType: GameType;
  maxPlayers: number;
  gameOptions: { [key: string]: string };
  turnTimerSeconds: 30 | 60 | 90;
  deckRoundsTarget?: number; // Tonk only; integer 5–12. Omitted → engine default (8). Big2 ignores it.
}

export interface SerializableGame {
  // ...existing fields unchanged...
  turnTimerSeconds: number | null;
  joinCode: string | null;
  deckRoundsTarget: number | null; // null = creator did not choose; engine uses default (8)
}
```

`SerializableGame.deckRoundsTarget` is `number | null` (not optional) to mirror the
existing `turnTimerSeconds: number | null` field exactly — the persisted shape always
carries the key.

### `src/backend/database/entities/Game.ts`

```ts
export class Game {
  // ...existing fields unchanged...
  turnTimerSeconds: number | null = null;
  joinCode: string | null = null;
  deckRoundsTarget: number | null = null; // INT column, nullable; NULL = unset → engine default
  // createdAt / updatedAt / version unchanged
}
```

### `src/backend/database/database.ts` — `GameRepository.createGame`

Add `deckRoundsTarget` as a parameter, positioned **before** `joinCode` so `joinCode`
stays the last argument (the existing duplicate-code retry loop and tests index it as the
last arg — see `createGame.test.ts` `args[6]`). Mirror `turnTimerSeconds`'s position:

```ts
createGame(
  gameId: string,
  gameType: GameType,
  creatorId: string,
  maxPlayers: number,
  creatorDisplayName: string,
  turnTimerSeconds: number | null,
  deckRoundsTarget: number | null, // NEW
  joinCode: string | null,
): Promise<Game>;
```

> Note: this shifts `joinCode` from arg index 6 to 7. `createGame.test.ts` asserts
> `args[6] === "H7K3"` — that assertion must move to `args[7]` (see Test Requirements).
> `gameService.createRematch` also calls `createGame` and must pass
> `oldGame.deckRoundsTarget` in the new slot (see Edge Cases §7).

### `src/backend/api/game/createGame.ts`

```ts
const MIN_DECK_ROUNDS_TARGET = 5;
const MAX_DECK_ROUNDS_TARGET = 12;
const DEFAULT_DECK_ROUNDS_TARGET = 8; // matches engine constants.ts

// In post(), after turnTimerSeconds validation:
const deckRoundsTarget = request.body.deckRoundsTarget;
if (
  deckRoundsTarget != null &&
  (!Number.isInteger(deckRoundsTarget) ||
    deckRoundsTarget < MIN_DECK_ROUNDS_TARGET ||
    deckRoundsTarget > MAX_DECK_ROUNDS_TARGET)
) {
  throw new BadRequestError();
}
// Pass `deckRoundsTarget ?? null` through createGameWithCode → gameRepo.createGame.
```

`createGameWithCode` gains a `deckRoundsTarget: number | null` parameter (mirroring
`turnTimerSeconds`) and forwards it to `gameRepo.createGame` in the new slot.

### `src/backend/service/gameService.ts` (line 102)

```ts
const config = {
  maxPlayers: game.maxPlayers,
  minPlayers,
  options: { deckRoundsTarget: game.deckRoundsTarget ?? 8 },
};
```

(The literal `8` should cite `DEFAULT_DECK_ROUNDS_TARGET` from `engine/tonk/constants.ts`
in a comment. Importing the constant directly is acceptable but optional — the engine
re-clamps regardless, so the literal is harmless defense-in-depth.)

### Migration `supabase/migrations/009_add_games_deck_rounds_target.sql`

```sql
-- 009: Add creator-configurable deckRoundsTarget to games (LLD 93 / #60).
-- Additive, nullable INT (mirrors turn_timer_seconds). NULL = creator did not
-- choose; gameService coalesces NULL to the engine default (8) at start.
-- Name-agnostic: a bare ADD COLUMN touches no constraint, so prod's games_pkey1
-- drift is irrelevant. IF NOT EXISTS makes the add re-runnable (001-008 discipline).
ALTER TABLE games
  ADD COLUMN IF NOT EXISTS deck_rounds_target INT;
```

### Post-condition `supabase/migrations/postconditions/009_add_games_deck_rounds_target.postcondition.sql`

Asserts SHAPE only — column presence and integer type — never a constraint name. Resolves
`games` via `search_path` (correct on drifted prod, clean CI, and the prod-shaped fixture):

```sql
-- Post-condition for 009 (LLD 77 §6): games has a deck_rounds_target column of
-- integer type. Name-agnostic / shape-based, idempotent, read-only.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT format_type(att.atttypid, att.atttypmod)
    INTO col_type
  FROM pg_attribute att
  WHERE att.attrelid = to_regclass('games')
    AND att.attname = 'deck_rounds_target'
    AND NOT att.attisdropped;

  IF col_type IS NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (009): games.deck_rounds_target column is missing.';
  END IF;

  IF col_type <> 'integer' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (009): games.deck_rounds_target is %, expected integer.',
      col_type;
  END IF;
END $$;
```

## State Model

- **Request → persistence:** `CreateGameRequest.deckRoundsTarget` (validated 5–12 or
  absent) → `gameRepo.createGame(... deckRoundsTarget ...)` → `games.deck_rounds_target`
  column (`INT`, nullable). Absent at API → NULL in DB.
- **Persistence → engine:** `startGame` reads `game.deckRoundsTarget` (mapped from the
  column by `mapGame`), coalesces NULL → 8, and places it in `config.options.deckRoundsTarget`.
  `engine.initialize` (Tonk) calls `resolveDeckRoundsTarget(config.options["deckRoundsTarget"])`,
  which re-clamps to [5,12] default 8.
- **Persisted vs in-memory:** `deck_rounds_target` is **persisted** on the `games` row
  (durable, set once at creation, never mutated). It is read at `startGame` time into the
  ephemeral `config.options` passed to the engine; the resolved value then lives inside the
  in-memory/persisted Tonk game `state` (the engine cuts the deck from it). The column
  itself is creation-time config, analogous to `turn_timer_seconds` — never updated after
  insert. `saveGame` must still write the column (round-trip integrity) but the value is
  immutable post-creation.
- **Big2:** the column is populated only if a client sends the field; Big2 clients omit
  it → NULL. The Big2 engine never reads `config.options`, so the value is inert for Big2.

## Edge Cases

1. **Field omitted (Big2 or default Tonk):** `deckRoundsTarget == null` → no 400; column
   stored as NULL; `startGame` coalesces to 8. Big2 unaffected.
2. **Out of range (e.g. 0, 4, 13, 100):** 400 `BadRequestError` at `createGame.ts`.
3. **Non-integer (e.g. 7.5):** rejected by `Number.isInteger` → 400. (Engine would round,
   but the API boundary is authoritative and rejects it.)
4. **Non-number (string, NaN, Infinity):** `Number.isInteger` is false for all of these →
   400. (`Infinity`/`NaN` fail `Number.isInteger`.)
5. **`null` explicitly sent:** `deckRoundsTarget != null` is false → treated as omitted →
   accepted, stored NULL. (Matches "absent → default".)
6. **Boundary values 5 and 12:** both accepted (inclusive range).
7. **Rematch (`createRematch`):** `createRematch` calls `gameRepo.createGame` and must
   supply the new `deckRoundsTarget` argument. **Decision: pass `oldGame.deckRoundsTarget`**
   (carry the original creator's choice into the rematch). This is the least-surprising
   behavior and costs nothing — `oldGame.deckRoundsTarget` is already loaded. (It is in the
   non-goal list only in the sense that no new UI/flow is added; threading the existing
   value through the existing call is required so the compile passes and rematch honors the
   original setting.)
8. **Existing prod `games` rows after migration:** all have `deck_rounds_target = NULL`
   (the additive column has no DEFAULT). `mapGame` reads NULL → `game.deckRoundsTarget =
   null` → coalesces to 8. No backfill needed; no abort guard needed.
9. **Migration re-run:** `IF NOT EXISTS` → no-op second time. Post-condition is idempotent
   and read-only.
10. **Prod PK drift (`games_pkey1`):** irrelevant — the migration touches no constraint and
    names none. The post-condition resolves `games` by name via `search_path` and inspects
    only the column, never the PK.

## Dependencies

- **PR #93 migration-safety harness (DELIVERED to origin/main):** `prodShapedFixture.ts`,
  `postconditionRunner.ts`, the drift gate, and `expected-diff.allowlist.json` all exist.
  This LLD consumes them; no new harness work.
- **Tonk engine `resolveDeckRoundsTarget`** (`src/backend/engine/tonk/deck.ts`) and
  constants `MIN/MAX/DEFAULT_DECK_ROUNDS_TARGET` (`constants.ts`) — already merged
  (#57/PR #98). No changes; this LLD only feeds them.
- **No dependency on LLD 66 / #78 `player_stats` migrations.** Different table, separate
  PR. The new migration is numbered after the highest existing (`008_...`) → `009_...`;
  if #78 or another branch lands a `009`, renumber to the next free integer before merge.

## Test Requirements

### Unit — API validation (`tests/api/createGame.test.ts`)

- Accepts `deckRoundsTarget` omitted (existing Big2 happy-path cases already cover this;
  ensure they still pass with the new optional field).
- Accepts boundary values 5 and 12 (200, forwarded to `createGame`).
- Accepts a mid-range value (e.g. 8) and forwards it.
- Rejects below range (4), above range (13) → 400.
- Rejects non-integer (7.5) → 400.
- Rejects non-number / NaN / Infinity → 400.
- Treats explicit `null` as omitted (accepted).
- **Update existing assertion:** `joinCode` arg moves from `args[6]` to `args[7]`; add an
  assertion that the `deckRoundsTarget` slot (`args[6]`) carries the validated value (or
  `null` when omitted).

### Unit — `gameService.startGame`

- Asserts the engine receives `config.options.deckRoundsTarget` equal to the persisted
  `game.deckRoundsTarget` when set (use a spy/stub engine, or assert via Tonk
  `initialize` producing the corresponding cut size).
- Asserts NULL `game.deckRoundsTarget` coalesces to 8 in `config.options`.
- Big2 start path is unaffected (value present in options but ignored by Big2 engine).

### Unit — repository mapper (`supabaseDb.mapGame`)

- `mapGame` maps `deck_rounds_target` → `game.deckRoundsTarget` (number and NULL → null).
  (If there is an existing mapper unit test, extend it; otherwise this is exercised via the
  integration round-trip below.)

### Integration — persistence round-trip

- create → getGame returns the `deckRoundsTarget` that was sent (e.g. 10), against the live
  `supabase start` DB. **Note:** this round-trip only passes after migration 009 is applied
  to the local DB; ensure the local migration set includes 009.
- create with the field omitted → getGame returns `deckRoundsTarget === null`.

### Integration — migration safety (extend `postcondition-runner.test.ts` pattern)

- **Coverage (already enforced):** the existing `checkCoverage` test will fail until the
  009 post-condition file exists — this guarantees the post-condition ships with the
  migration. No new test needed; just confirm it stays green.
- Add 009 to the migration list in the prod-shaped-fixture and fresh-baseline
  "all post-conditions pass" tests (the two `applyMigrations([...])` arrays), so the 009
  post-condition runs against **both** the `typeorm-era` (drifted, `games_pkey1`) baseline
  and the `fresh` baseline — proving name-agnosticism.
- A focused test: apply 001..009 to a `typeorm-era` prod-shaped fixture, then run the 009
  post-condition in isolation and assert it resolves (column present, integer type).

### Engine (no new tests required here)

`resolveDeckRoundsTarget` and the cut math are already tested (LLD 65/#57). This LLD adds
no engine logic, so no new engine tests — but the `startGame` integration above transitively
confirms the value reaches the cut.

### Security / boundary

- Out-of-range and non-integer inputs are rejected at the API boundary (covered above) —
  this is the trust boundary per architecture-principles §1 ("never trust client data
  beyond the validated set"). The engine clamp is defense-in-depth, not the gate.

### Explicitly NOT tested

- No prod-connection test (human-owned release step, LLD 77 §9).
- No UI tests (no UI in this slice).
