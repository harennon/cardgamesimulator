# LLD 66: Game-Specific Player Stats (per game type)

**Status: Design — docs only. No production code changes in this PR.**

Today player stats are **global per user**: a single `player_stats` row keyed by `user_id` pools every game's results together, so a player's Big2 record and Tonk record are indistinguishable. This LLD makes stats **per game type** — segmenting by `game_type` so each `(user_id, game_type)` pair has its own row. This is a cross-cutting change that affects the **already-shipped Big2** pipeline, not just Tonk.

> **Relationship to LLD 65 (Tonk, PR #76).** LLD 65 §6.3 forward-references "a separate forthcoming stats LLD" for per-game-type stats and explicitly scopes itself to the existing **global** contract, changing only Tonk's win/loss *derivation*. **This is that LLD.** It supplies the per-game-type dimension LLD 65 defers, and it is compatible with LLD 65's multi-winner mapping (see §7). The two changes are independent and can ship in either order (see §8.4).

---

## 1. Scope

### In scope

- **Schema:** a new additive migration that adds `game_type` to `player_stats`, changes the primary key to the composite `(user_id, game_type)`, and **backfills** existing rows.
- **RPC:** a new migration that redefines `increment_player_stats` to take `p_game_type` and use the composite conflict target. (Never edits `001`/`003` in place.)
- **Entity / repo / `StatsDelta`:** thread `gameType` through `PlayerStats`, `getStats`, and `incrementStats`.
- **Read path:** both a **single-game** read (`getStats(userId, gameType)`) and an **all-games aggregate** read (`getAllStats(userId)` → one entry per game type the user has played).
- **Service:** `StatsService.recordGameCompletion` sourcing `gameType` from `state.gameType` (already present — see §2.1) and passing it down.
- **Read API:** how `GET /stats` exposes per-game stats (the API gains a per-game breakdown).
- **Frontend (architecture level only):** the data shape the frontend consumes and which surface displays it. No pixel mockups here (see §6.4 for the mockup flag).
- **Backward compatibility / rollout** of the schema change.
- **Test requirements** for per-game isolation, composite-key upsert, backfill, guest-skip, and the read paths.

### Explicitly NOT in scope

- Any change to game **engine** state, rules, or `InternalGameState` (it already carries `gameType`).
- Tonk's win/loss derivation logic — owned by LLD 65 §6.3 / engine sub-issue #57. This LLD only guarantees the pipeline *carries* `gameType` and keeps `StatsDelta` counters independent so the multi-winner mapping still works (§7).
- Leaderboards, cross-user stat lookup, or aggregating an "all games combined" total for a user (we expose per-game rows; a combined total, if ever wanted, is a trivial client-side sum and is called out as a non-goal here).
- A new frontend stats *page* (none exists today — see §6.1). This LLD designs the data contract that page would consume; building the page is a separate issue.
- Migrating the post-match `GameOverView` derivation (LLD 38) — that is client-derived from in-memory `playHistory` and does not touch `player_stats`.

---

## 2. Approach

### 2.1 Key insight: `gameType` is already available where stats are recorded

`InternalGameState` already declares `readonly gameType: GameType` (`src/shared/engine-types.ts:65`). `StatsService.recordGameCompletion(state)` (`statsService.ts:18`) receives the full state, so **`state.gameType` is the source of truth for the game type** — no threading from the `GameService.applyAction` call site (`gameService.ts:144-148`) is required. This is the cleanest seam: the gameType travels with the state object the service already holds.

> **Verified:** I confirmed the call site passes `result.newState` (an `InternalGameState`) to `recordGameCompletion`. The `Game` DB entity also has `gameType: GameType`, but we do **not** need it here because the state object already carries it. Using `state.gameType` keeps the service free of any extra dependency and matches the pure-state-in design (architecture-principles #4/#9: transport/service stays thin).

### 2.2 Key technical decisions and rationale

1. **Composite primary key `(user_id, game_type)`, not a surrogate id.** The natural key is `(user_id, game_type)` — there is exactly one stats row per user per game. A composite PK gives us atomic upsert via `ON CONFLICT (user_id, game_type)` with zero extra index. Rationale: matches the existing atomic-upsert pattern (003), keeps the table narrow, and the read paths (§4) query by `user_id` (all games) or `(user_id, game_type)` (one game) — both covered by the composite PK index.

2. **Backfill existing rows as `'big2'`.** Big2 is the **only shipped game** to date (Tonk is docs-only, gated behind LLD 65 §9 sign-off, and has never run in production). Therefore every existing `player_stats` row was produced exclusively by Big2 games. Backfilling `game_type = 'big2'` is **lossless and correct** — it attributes historical results to the game that actually produced them. This is documented and asserted as a migration invariant (§3, §8.2).

3. **`game_type` column with a `NOT NULL DEFAULT 'big2'`, then drop the default.** The migration adds the column with `DEFAULT 'big2' NOT NULL` so the backfill of existing rows happens in the same `ALTER` (Postgres fills existing rows with the default). We then **drop the column default** so future inserts must specify the game type explicitly (the RPC always does — §3.2). Rationale: the default is a one-shot backfill device, not a permanent fallback; leaving it would silently mis-attribute a future insert that forgot the game type. (Alternative considered: separate `UPDATE` backfill — rejected as it requires the column to be nullable first, adding a window where rows have `NULL` game_type. The default-then-drop approach has no null window. See §8.2.)

4. **Single-game read AND aggregate read, both supported.** The repo exposes:
   - `getStats(userId, gameType)` → the one row for that game (or `null`).
   - `getAllStats(userId)` → an array of all the user's per-game rows.
   The `GET /stats` endpoint uses `getAllStats` and returns a **breakdown keyed by game type** (§4.3). Rationale: the product intent ("show a player's Big2 record and Tonk record separately") needs the breakdown; a single-game read is also useful (e.g. the post-match screen showing just the game you finished). Supporting both is cheap because both are covered by the composite PK index.

5. **No change to `StatsDelta`'s shape.** `StatsDelta` (`database.ts:23-27`) stays `{ gamesPlayed, gamesWon, gamesLost, totalScore }`. The `gameType` is passed as a **separate parameter** to `incrementStats`, not folded into the delta. Rationale: the delta describes "what changed numerically"; the game type identifies "which row" — keeping them separate mirrors the `(key, delta)` shape of the underlying upsert and avoids touching the delta type that LLD 65 §6.3 relies on being unchanged.

6. **`game_type` is a free-text `VARCHAR`, validated by the application, not a DB enum.** The `games.game_type` column is already `VARCHAR(50)` (001:5), not a Postgres enum. We mirror that for consistency and to avoid an enum-migration dance every time a game is added. The `GameType` TypeScript union (`"big2" | "tonk"`) is the validation boundary; the value always originates from `state.gameType`, which is already typed. (Alternative: a Postgres `ENUM` or a CHECK constraint — rejected for consistency with the existing `games` table and because adding a game would then require a schema migration. Optional hardening: a `CHECK (game_type IN ('big2','tonk'))` could be added, but it couples the schema to the game roster and is **not recommended**; noted as a possible future tightening, not adopted.)

---

## 3. Schema Migration

Two new migration files. **Neither edits `001`/`002`/`003` in place** (those are already applied; editing them would not re-run and would diverge local/prod). Files are numbered to run after `003`.

### 3.1 `004_player_stats_game_type.sql` — column + composite PK + backfill

> **Mandatory precondition before writing `004` (constraint-name verification).** The drop in step 4 below names the PK constraint explicitly. `player_stats_pkey` is *Postgres's conventional default* for an inline `PRIMARY KEY` on a table created as `player_stats` (`001:19`), but the migration must not assume it blindly. **Before authoring `004`, the implementer MUST verify the actual PK constraint name against the live/target DB** with either `\d player_stats` (psql) or:
> ```sql
> SELECT conname FROM pg_constraint
> WHERE conrelid = 'player_stats'::regclass AND contype = 'p';
> ```
> If the returned name is not `player_stats_pkey`, substitute the real name in step 4. This is a hard precondition, not a footnote: a wrong constraint name makes `004` fail at apply time.

The migration must be **idempotent / safely re-runnable if partially applied**, matching the discipline of `001`–`003` (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Each step uses `IF EXISTS` / `IF NOT EXISTS` guards so a re-run after a partial apply is a no-op rather than an error.

Design (SQL is illustrative; the implementer owns exact syntax, but the idempotency guards and the explicit constraint name are required):

```sql
-- 004: Make player_stats game-specific.
-- Adds game_type, backfills existing (Big2-only) rows, and repoints the PK
-- to the composite (user_id, game_type). Idempotent: safe to re-run if a prior
-- apply was interrupted (matches the IF [NOT] EXISTS discipline of 001-003).

-- 1. Backfill-safety guard: abort loudly if any non-big2 game has completed,
--    which would make the 'big2' backfill mis-attribute results (see §8.2 / edge
--    case #9). Placed FIRST so the migration aborts before mutating anything.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM games
      WHERE game_type <> 'big2' AND status = 'COMPLETED') > 0 THEN
    RAISE EXCEPTION
      'Migration 004 aborted: % completed non-big2 game(s) exist. Backfilling player_stats as ''big2'' would mis-attribute their results. See LLD 66 §8.2.',
      (SELECT COUNT(*) FROM games WHERE game_type <> 'big2' AND status = 'COMPLETED');
  END IF;
END $$;

-- 2. Add the column with a one-shot backfill default.
--    Postgres fills all existing rows with 'big2' atomically (Big2 is the
--    only game shipped to date — see §2.2 decision 2). NOT NULL is safe
--    because the default covers every existing row. IF NOT EXISTS makes the
--    add re-runnable.
ALTER TABLE player_stats
  ADD COLUMN IF NOT EXISTS game_type VARCHAR(50) NOT NULL DEFAULT 'big2';

-- 3. Drop the default so future inserts MUST specify game_type explicitly
--    (the RPC always does). The default was only a backfill device.
--    DROP DEFAULT is a no-op if already dropped, so this is naturally re-runnable.
ALTER TABLE player_stats
  ALTER COLUMN game_type DROP DEFAULT;

-- 4. Repoint the primary key from (user_id) to (user_id, game_type).
--    DROP CONSTRAINT IF EXISTS makes the drop re-runnable; the ADD is guarded by
--    a NOT-EXISTS check so a re-run after the PK is already composite is a no-op.
--    NOTE: 'player_stats_pkey' MUST be the name verified by the precondition above.
ALTER TABLE player_stats DROP CONSTRAINT IF EXISTS player_stats_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_stats'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE player_stats
      ADD CONSTRAINT player_stats_pkey PRIMARY KEY (user_id, game_type);
  END IF;
END $$;
```

Notes:
- **Backfill-safety guard (step 1):** the `DO $$ ... RAISE EXCEPTION ... $$` block is the enforcement mechanism for the §8.2 precondition — see §8.2 for the decision rationale. It converts the silent-corruption hazard (edge case #9) into a loud, safe abort: if a non-`big2` game has completed, `004` aborts before adding the column or touching any data, leaving the schema untouched.
- **Constraint name (step 4):** the explicit name `player_stats_pkey` must match the verified name from the precondition above. The `DROP CONSTRAINT IF EXISTS` + guarded `ADD` pair is idempotent: re-running after a partial apply (PK already dropped, or already recreated as composite) is a safe no-op.
- RLS: `002`'s policy `auth.uid() = user_id` (`002:22-24`) still applies unchanged — it filters on `user_id`, which is still a column. Adding `game_type` to the PK does **not** weaken or change the policy. No RLS migration needed.
- Grants from `001` (`GRANT ... ON player_stats TO service_role/authenticated/anon`) are table-level and survive the column/PK change. No re-grant needed.
- Existing GIN/index objects on `player_stats`: there are none beyond the PK; nothing else to rebuild.

### 3.2 `005_increment_stats_rpc_game_type.sql` — RPC with `p_game_type`

Redefine the function (`CREATE OR REPLACE`) to take the game type and use the composite conflict target. Mirrors `003` exactly except for the new parameter and conflict target:

```sql
CREATE OR REPLACE FUNCTION increment_player_stats(
  p_user_id    UUID,
  p_game_type  VARCHAR,
  p_games_played INT,
  p_games_won    INT,
  p_games_lost   INT,
  p_total_score  INT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO player_stats (user_id, game_type, games_played, games_won, games_lost, total_score, last_played_at)
  VALUES (p_user_id, p_game_type, p_games_played, p_games_won, p_games_lost, p_total_score, NOW())
  ON CONFLICT (user_id, game_type) DO UPDATE SET
    games_played  = player_stats.games_played + p_games_played,
    games_won     = player_stats.games_won    + p_games_won,
    games_lost    = player_stats.games_lost   + p_games_lost,
    total_score   = player_stats.total_score  + p_total_score,
    last_played_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION increment_player_stats FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_player_stats FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION increment_player_stats TO service_role;
```

> **Signature-change caveat.** Adding a parameter changes the function's signature. `CREATE OR REPLACE FUNCTION` can only replace a function with the **same argument list**; a different arg list creates a **new overload** and leaves the old 5-arg function in place. To avoid two overloads coexisting (and the backend accidentally calling the stale 5-arg one), the migration must `DROP FUNCTION increment_player_stats(UUID, INT, INT, INT, INT);` **before** creating the new 6-arg version. The implementer must drop the old signature explicitly in `005`. (This is also why the schema migration and the backend RPC-call change must deploy together — §8.3.)

> **`SECURITY DEFINER` re-verify.** Recreating the function preserves the `SECURITY DEFINER` semantics from `003`. The `REVOKE`/`GRANT` block must be repeated in `005` because a dropped-and-recreated function does **not** inherit the old grants.

---

## 4. Interfaces / Types

### 4.1 Entity — `PlayerStats`

Add `gameType` (`src/backend/database/entities/PlayerStats.ts`):

```typescript
import type { GameType } from "@shared/engine-types";

export class PlayerStats {
  userId: string = "";
  gameType: GameType = "big2"; // part of the composite key with userId
  gamesPlayed: number = 0;
  gamesWon: number = 0;
  gamesLost: number = 0;
  totalScore: number = 0;
  lastPlayedAt: Date = new Date();
}
```

### 4.2 Repository — `PlayerStatsRepository`

`StatsDelta` is **unchanged**. The interface (`database.ts`) gains a `gameType` parameter on the write path and an aggregate read:

```typescript
export interface PlayerStatsRepository {
  /** Stats for one user in one game type, or null if they've never played it. */
  getStats(userId: string, gameType: GameType): Promise<PlayerStats | null>;

  /** All per-game-type stat rows for a user (one entry per game type played; may be empty). */
  getAllStats(userId: string): Promise<PlayerStats[]>;

  /**
   * Atomically increment stats for (userId, gameType). Creates the row if absent.
   * Uses SQL ON CONFLICT (user_id, game_type) DO UPDATE to avoid races.
   */
  incrementStats(
    userId: string,
    gameType: GameType,
    delta: StatsDelta,
  ): Promise<void>;
}
```

> **Breaking signature change (intentional).** `getStats(userId)` → `getStats(userId, gameType)` and `incrementStats(userId, delta)` → `incrementStats(userId, gameType, delta)`. Every caller must be updated in the same change. Callers verified today: `StatsService.recordGameCompletion` (write) and `GetStatsHandler` (read). See §4.4, §4.5.

### 4.3 Supabase implementation — `SupabaseDB`

- `getStats` adds `.eq("game_type", gameType)` to the existing `.eq("user_id", userId)` query (`supabaseDb.ts:130-139`).
- `getAllStats` queries `.eq("user_id", userId)` with **no** `.maybeSingle()` — returns all rows, mapped via `mapPlayerStats`.
- `incrementStats` passes `p_game_type: gameType` to the RPC (`supabaseDb.ts:141-153`).
- `mapPlayerStats` reads `row.game_type as GameType` into `stats.gameType` (`supabaseDb.ts:213-221`).

### 4.4 Service — `StatsService.recordGameCompletion`

Source the game type from the state and pass it to every `incrementStats` call (`statsService.ts:18-43`):

```typescript
async recordGameCompletion(state: InternalGameState): Promise<void> {
  if (state.status !== "COMPLETED") return;
  if (!state.scores || state.scores.length === 0) return;

  const gameType = state.gameType; // already on InternalGameState — no new dependency
  const winnerId = state.winner;

  for (const playerScore of state.scores) {
    if (this.isGuest(playerScore.playerId)) continue;

    const delta: StatsDelta = {
      gamesPlayed: 1,
      gamesWon: playerScore.playerId === winnerId ? 1 : 0,
      gamesLost: playerScore.playerId !== winnerId ? 1 : 0,
      totalScore: playerScore.score,
    };

    try {
      await this.statsRepo.incrementStats(playerScore.playerId, gameType, delta);
    } catch (err: unknown) {
      console.error(`Failed to record stats for player ${playerScore.playerId}:`, err);
    }
  }
}
```

> The win/loss derivation shown above is the **current Big2** single-winner derivation, unchanged. LLD 65 §6.3 replaces the derivation **for Tonk** (tally-vs-150, multi-winner) — that is its concern, not this LLD's. This LLD's only contract to LLD 65 is: `incrementStats` now requires a `gameType` arg (always `state.gameType`), and `StatsDelta` counters remain independent (§7).

### 4.5 Read API — `GetStatsResponse`

The endpoint returns a **per-game breakdown**. Replace the flat `GetStatsResponse` (`src/shared/model.ts:62-70`) with a per-game shape:

```typescript
export interface GameStatsEntry {
  gameType: GameType;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  totalScore: number;
  winRate: number;              // gamesWon / gamesPlayed (0 if none), rounded to 3 dp
  lastPlayedAt: string | null;  // ISO 8601
}

export interface GetStatsResponse {
  userId: string;
  games: GameStatsEntry[];      // one entry per game type the user has played; [] if none
}
```

`GetStatsHandler` (`src/backend/api/stats/getStats.ts`) calls `statsRepo.getAllStats(userId)`, maps each row to a `GameStatsEntry` (computing `winRate` per entry, reusing the existing `Math.round(... * 1000) / 1000` rounding from `getStats.ts:27`), and returns `{ userId, games }`. A user with no games returns `{ userId, games: [] }`.

> **API shape decision.** Returning an **array of per-game entries** (rather than an object keyed by game type, e.g. `{ big2: {...}, tonk: {...} }`) is preferred: it is forward-compatible (new games just add array entries with no client-side key plumbing), trivially iterable in the frontend, and naturally represents "games the user has actually played" (absent game types simply don't appear). The frontend renders zeros for game types the user has never played if it wants to show all known games (it owns the full game roster).

> **Optional query param (not required for v1):** `GET /stats?gameType=big2` could return a single `GameStatsEntry` via `getStats(userId, gameType)`. Not adopted now — the breakdown covers the product need and a single-game filter can be added later without breaking the array shape. Flagged so the implementer doesn't build it speculatively (CLAUDE.md simplicity rule).

---

## 5. State Model

### Persistence (after migration)

`player_stats` table:

| Column | Type | Notes |
|--------|------|-------|
| user_id | uuid | Composite PK part 1. References Supabase `auth.users.id` (no FK). |
| game_type | varchar(50) | Composite PK part 2. `'big2'` \| `'tonk'`. |
| games_played | int | Incremented per completed game of that type. |
| games_won | int | Per `StatsDelta` (independent counter — §7). |
| games_lost | int | Per `StatsDelta` (independent counter — §7). |
| total_score | int | Sum of placement scores **for that game type**. Note Tonk scores are penalties (lower-is-better) per LLD 65 §6.3 — `total_score` is not comparable across game types, which is exactly why segmentation matters. |
| last_played_at | timestamptz | Updated on each completion of that type. |

Primary key: `(user_id, game_type)`. No additional indexes needed (PK covers both read paths).

### Data flow

```
Game completes (player action or timer auto-play), status -> COMPLETED:
  GameService.applyAction
    -> statsService.recordGameCompletion(newState)
       gameType = newState.gameType            // already on the state
       for each non-guest player score:
         statsRepo.incrementStats(playerId, gameType, delta)
           -> RPC increment_player_stats(p_user_id, p_game_type, ...)
              -> INSERT ... ON CONFLICT (user_id, game_type) DO UPDATE col = col + delta

GET /stats:
  GetStatsHandler.get
    -> statsRepo.getAllStats(userId)            // all per-game rows
    -> map each row to GameStatsEntry (compute winRate)
    -> { userId, games: GameStatsEntry[] }
```

### In-memory vs persisted

Unchanged from LLD 7b: stats are **persisted only**, no caching (read frequency is low — dashboard/profile loads, never the game hot path). `GuestSessionStore` remains in-memory.

---

## 6. Frontend (architecture level)

### 6.1 Current state

There is **no lifetime/profile stats UI today.** `GET /stats` is wired server-side only and **no frontend code calls it** (verified: zero references to `/stats`, `getStats`, `GetStatsResponse`, `winRate` in `src/frontend`). The only stats surface is the post-match `GameOverView` (LLD 38), which derives per-match numbers **client-side from in-memory `playHistory`** and does **not** touch `player_stats`. So this LLD changes a backend contract that currently has **no frontend consumer**.

### 6.2 What the frontend consumes (data shape, not layout)

When a stats page is built (separate issue), it consumes `GetStatsResponse.games: GameStatsEntry[]`. The natural rendering is **one card/row per game type** (Big 2, Tonk, …) showing games played / won / lost / win rate, using the existing game-type labels already in `CreateGameView.vue` (`big2` → "Big 2"). The frontend owns the full game roster, so it can render a zeroed entry for a game the user has never played (or simply omit it).

### 6.3 Game-type selector pattern already exists

`CreateGameView.vue` already has a `<select>` mapping `GameType` → label (`big2` → "Big 2"). A stats page can reuse that mapping (extract a tiny shared `GAME_TYPE_LABELS` map if/when a second consumer needs it) — but **do not** build that abstraction speculatively in this change (single-use today; CLAUDE.md simplicity rule). This is a note for the future stats-page issue, not work for this LLD.

### 6.4 Mockup flag

Per CLAUDE.md, any LLD that changes visual UI needs a `frontend-architect` HTML mockup approved before implementation. **This LLD does not ship UI** — it changes a backend contract with no current frontend consumer. **No mockup is required for this change.** When the stats *page* is built (the future issue that consumes `GameStatsEntry[]`), that issue must go through the `frontend-architect` mockup step. Flagged so the page work isn't started straight from text specs.

---

## 7. Compatibility with LLD 65 (Tonk multi-winner mapping)

LLD 65 §6.3 derives, per player at `COMPLETED`, `gamesLost = (finalTally >= 150) ? 1 : 0` and `gamesWon = (finalTally >= 150) ? 0 : 1` (everyone who did not lose won), with `breakdown.trueLoser` as a within-losers flavor distinction. Multiple winners are possible.

This LLD is **fully compatible** with that mapping:

1. **`StatsDelta` counters stay independent.** `gamesWon` and `gamesLost` remain separate integers (`database.ts:23-27`, unchanged here). Tonk's derivation sets them independently per player; nothing in this LLD couples them. Confirmed: the multi-winner mapping needs no `StatsDelta` change, and we make none.
2. **Per-game segmentation is exactly what Tonk needs.** Tonk's `totalScore` is a penalty (lower-is-better), the inverse of Big2's higher-is-better. Pooling them in one global row (today's behaviour) is **semantically broken**; segmenting by `game_type` (this LLD) is what makes a Tonk `total_score` meaningful in isolation. So this LLD doesn't just *tolerate* Tonk — it's a prerequisite for Tonk stats to mean anything.
3. **Ordering is independent (§8.4).** Tonk's derivation change and this segmentation change touch different code (derivation logic vs. the `(key)` the upsert targets) and can land in either order. If this LLD lands first, Tonk results flow into the `'tonk'` row with the (then-current) derivation. If Tonk lands first, its results temporarily pool into the global row — then this migration backfills them as `'big2'`, **mis-attributing them**. Therefore: **this LLD should land before or together with any Tonk game actually running in production.** Since Tonk is gated behind LLD 65 §9 sign-off and not yet runnable, that ordering is naturally satisfied today (see §8.2 backfill-correctness note).

---

## 8. Backward Compatibility & Rollout

### 8.1 Migration ordering

`004` (column + PK + backfill) must run **before** `005` (RPC). `005` references the composite conflict target that `004` creates. Both run after `003`. Supabase applies migrations in filename order, so the `004`/`005` numbering enforces this.

### 8.2 Is the backfill safe and correct?

**Yes, given Big2 is the only game ever run in production.** Every existing `player_stats` row was produced solely by Big2 completions (Tonk is docs-only, gated, never executed). Backfilling `game_type = 'big2'` therefore attributes each historical row to the exact game that produced it — **lossless**. The precondition is: **no non-`big2` game has ever completed** (`SELECT COUNT(*) FROM games WHERE game_type <> 'big2' AND status = 'COMPLETED'` must be `0`). Today it is `0` (Tonk gated). If that count is ever non-zero at migration time, the backfill assumption is violated — those rows' contributions would be wrongly attributed to Big2.

**Enforcement decision: encode the check inside `004` itself as a hard guard (not a runbook step).** The migration runs a `DO $$ ... RAISE EXCEPTION ... $$` block (shown as step 1 in §3.1) *before* adding the column or backfilling. If the count is non-zero the migration **aborts loudly** with a clear message and mutates nothing; if it is zero the migration proceeds.

Exact guard SQL (this is the authoritative spec; §3.1 step 1 embeds the same block):

```sql
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM games
      WHERE game_type <> 'big2' AND status = 'COMPLETED') > 0 THEN
    RAISE EXCEPTION
      'Migration 004 aborted: % completed non-big2 game(s) exist. Backfilling player_stats as ''big2'' would mis-attribute their results. See LLD 66 §8.2.',
      (SELECT COUNT(*) FROM games WHERE game_type <> 'big2' AND status = 'COMPLETED');
  END IF;
END $$;
```

Rationale for in-migration guard over a runbook gate: this is a **silent, non-self-healing data-corruption hazard** (once mis-attributed, the rows are indistinguishable — there is no later signal to detect or repair it). A manual prose precondition can be skipped or forgotten; an in-migration guard makes skipping impossible. The migration becomes self-protecting and fails closed: a non-zero count produces a loud abort instead of silently corrupting historical attribution. The check is cheap (one indexed count on `games.status`, `idx_games_status` from `001:38`) and runs once. Because the whole migration is idempotent (§3.1), a post-fix re-run after the precondition is satisfied is safe.

### 8.3 What breaks if deployed half-applied?

The backend's RPC call and the DB function signature must change **together**:

- **DB migrated (`004`+`005`) but backend still calls the old 5-arg RPC:** the call fails — `005` drops the 5-arg function (§3.2), so the backend gets a "function does not exist" error. `recordGameCompletion` is fire-and-forget with a `catch` (`gameService.ts:144-148`), so the **game is unaffected** but stats for that window are **silently lost**. Read path (`getStats`/`getAllStats`) still works (it's plain SELECTs). Severity: stats-loss only, no gameplay impact.
- **Backend deployed (calls 6-arg RPC) but DB not migrated:** the 6-arg function doesn't exist yet → same fire-and-forget failure, stats lost for the window, no gameplay impact. Reads against the old single-PK table still return rows (the new `getAllStats` works against the old schema too — it's a `user_id` filter).

**Conclusion:** the failure mode of a half-applied deploy is **lost stats during the window, never lost games and never corrupted data.** Recommended rollout: apply migrations `004`+`005` first (they are backward-compatible with the *old* backend only on the read path — writes break either way during the gap), then deploy the backend. To minimize the stats-loss window, run migrations and deploy backend close together. Because stats are informational and fire-and-forget (LLD 7b decision), a brief window of lost stats is acceptable and self-heals on the next game.

### 8.4 Relationship to Tonk ordering

See §7.3. This LLD must land **before any Tonk game runs in production** so Tonk results land in a `'tonk'` row rather than being backfilled as `'big2'`. Satisfied today because Tonk is gated.

### 8.5 Rollback

If `004`/`005` must be rolled back: a `down` migration would `DROP FUNCTION` the 6-arg version, recreate the 5-arg `003` version, repoint the PK back to `(user_id)`, and drop `game_type`. **But** dropping `game_type` after multiple game types exist would **collapse distinct rows into PK collisions** (two rows with the same `user_id` differing only by `game_type`). So rollback is only clean while `'big2'` is the only value present. Document this: **rollback is safe pre-Tonk; once Tonk rows exist, rollback requires merging rows (sum the counters) and is not a pure schema revert.** For v1 (pre-Tonk) the rollback is a clean revert. Forward-only is the recommended posture once Tonk ships.

---

## 9. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Big2 win must not touch the Tonk row | The upsert conflict target is `(user_id, game_type)`. A Big2 completion only ever upserts the `(user, 'big2')` row. Asserted by an isolation test (§10). |
| 2 | Player's first game of a given type (no row yet) | `INSERT ... ON CONFLICT` creates the `(user, game_type)` row. `getStats(user, type)` returns `null` until then; the endpoint omits that game from `games[]`. |
| 3 | Same player completes a Big2 and a Tonk game | Two distinct rows accumulate independently. `getAllStats` returns both; `games[]` has two entries. |
| 4 | Concurrent completions for the same `(user, game_type)` | `ON CONFLICT DO UPDATE SET col = col + $n` is atomic — final values are the sum. (Same guarantee as LLD 7b, now scoped to the composite key.) |
| 5 | Guest player in a completed game | Unchanged: `StatsService.isGuest` skips them before any `incrementStats` call. No row created, for any game type. |
| 6 | Existing global rows at migration time | Backfilled to `'big2'` by the column default (§3.1). Verified lossless because Big2 is the only shipped game (§8.2). |
| 7 | `game_type` value not in the `GameType` union | Cannot occur via the write path — `gameType` always originates from `state.gameType`, which is typed `GameType`. No DB-level CHECK is added (§2.2 decision 6); the type system is the boundary. |
| 8 | `getAllStats` for a user who has played nothing | Returns `[]`; endpoint returns `{ userId, games: [] }`. No error. |
| 9 | Migration run when a Tonk game has already completed (precondition violated) | Backfilling would mis-attribute those results to `'big2'`. **Enforced, not just flagged:** `004`'s in-migration guard (§3.1 step 1 / §8.2) runs `RAISE EXCEPTION` if `COUNT(*)` of completed non-`big2` games is non-zero, aborting the migration before any column add or backfill — the schema is left untouched. Converts the silent-corruption hazard into a loud, safe abort. Today the count is 0 (Tonk gated), so `004` proceeds. |
| 10 | Old 5-arg RPC still referenced after `005` drops it | Backend stats write fails fire-and-forget (logged, game unaffected). Resolved by deploying the backend RPC-call change with the migration (§8.3). |
| 11 | Server restart between game completion and stats write | Unchanged from LLD 7b: fire-and-forget, stats for that game lost. Acceptable (informational, not transactional). |

---

## 10. Test Requirements

> Per testing-principles: service logic is tested as pure-ish unit tests with a mocked repo; the composite-key upsert and backfill are tested at the integration/DB layer against a real test database. Self-contained tests, no shared state.

### Unit — `StatsService` (`tests/service/statsService.test.ts`, extend existing)

| # | Test | Verifies |
|---|------|----------|
| U1 | `incrementStats` is called with `state.gameType` | The gameType passed to the repo equals the state's gameType (e.g. `"big2"`), for each non-guest player. |
| U2 | Different `gameType` in state → different arg | Constructing a state with `gameType: "tonk"` causes `incrementStats(..., "tonk", ...)`. (Pure mapping test; does not exercise Tonk derivation.) |
| U3 | Guest still skipped | No `incrementStats` call for guest players, regardless of game type. (Regression of LLD 7b behaviour.) |
| U4 | Counters in delta unchanged | The `StatsDelta` passed still has `{ gamesPlayed:1, gamesWon, gamesLost, totalScore }`; win/loss values match the (current Big2) derivation. Locks the §7 "counters independent / shape unchanged" contract. |
| U5 | Early returns preserved | Non-`COMPLETED` status or empty/null `scores` → no `incrementStats` calls. |

Approach: mock `PlayerStatsRepository` and `GuestSessionStore`; construct `InternalGameState` inline with a chosen `gameType` and known scores; assert the args to `incrementStats`.

### Integration — repository / DB (`tests/integration/player-stats.test.ts`, extend existing)

| # | Test | Verifies |
|---|------|----------|
| I1 | Per-game isolation | After incrementing `(user, 'big2')`, `getStats(user, 'tonk')` is `null` and `getStats(user, 'big2')` reflects the increment. A Big2 win does not alter any Tonk row. |
| I2 | Composite-key upsert correctness | Two `incrementStats(user, 'big2', delta)` calls sum into one row; a third call with `'tonk'` creates a **second** row. `getAllStats(user)` returns exactly two entries with the expected per-game values. |
| I3 | Atomic concurrent upsert (same composite key) | Two concurrent `incrementStats(user, 'big2', ...)` both succeed; final values are the sum (no lost update). |
| I4 | Backfill correctness | Seed a row under the **pre-migration** schema (or simulate it), run `004`, assert the row now has `game_type = 'big2'` and the PK is composite. Assert no row has a null/empty game_type. |
| I5 | `getAllStats` empty | New user → `getAllStats` returns `[]`. |
| I6 | `getStats(user, type)` single-row | Returns exactly the one matching row or `null`; never bleeds another game type's counters. |
| I7 | RPC signature | Calling the 6-arg `increment_player_stats` succeeds; (optional) the old 5-arg signature no longer exists after `005` (negative check). |

### Integration — read API (`GET /stats`)

| # | Test | Verifies |
|---|------|----------|
| A1 | New user → `{ games: [] }` | Authenticated user with no games gets an empty `games` array, not an error. |
| A2 | After a Big2 completion | `games` contains one entry with `gameType: "big2"`, `gamesPlayed: 1`, correct `winRate`. |
| A3 | After Big2 + Tonk completions | `games` contains two entries, each with its own counters; counters do not bleed across entries. (Tonk completion can be simulated by recording with `gameType: "tonk"` — does not require the Tonk engine, keeping this independent of LLD 65.) |
| A4 | `winRate` per entry | Each entry's `winRate` = round(gamesWon/gamesPlayed, 3); 0 when `gamesPlayed` is 0. |
| A5 | 401 without auth | Unchanged — unauthenticated request rejected. |

### Test infrastructure notes — how migrations are applied (resolved)

**Application mechanism (verified):** migrations are applied **by the Supabase CLI, not by any in-tree code**. `supabase start` (configured by `supabase/config.toml`) brings up the local Postgres and applies every file in `supabase/migrations/` **in filename order**. This is the only application path:
- **CI:** `.github/workflows/ci.yml` runs `supabase start` in both the `integration-tests` (`:34`) and `e2e-tests` (`:56`) jobs before `npm run test:integration` / Playwright.
- **Local:** `DEVELOPMENT.md` (Environment Setup) instructs `supabase start` before `npm run dev` / integration tests.
- The integration test harness itself (`vitest.integration.config.ts` → `tests/integration/helpers/setupEnv.ts`) does **not** apply migrations — it only loads env and connects to the already-running Supabase DB. A grep for the migration filenames returns nothing in test/app code precisely because the application path is the CLI driven by the directory contents.

**Therefore the entire hook for `004`/`005` is: drop the two files into `supabase/migrations/` with the next free sequential names.** The next free numbers on this branch are `004` and `005` (only `001`–`003` are tracked here — verify with `git ls-files supabase/migrations/` at implementation time, since a `004_join_codes.sql` existed earlier in history before being folded into `001`, and confirm no collision). Once present, `supabase start` applies them automatically in CI and locally before any test runs — no harness change, no bootstrap script, no extra wiring needed. This is the concrete hook for the **I7 RPC-signature test** (it just calls the 6-arg `increment_player_stats` against the started DB, and negative-checks the 5-arg overload is gone) and for the **A1–A5 read-API tests**.

**I4 (backfill) is the one exception — it cannot use the standard harness.** A clean `supabase start` already applies `004`, so the live DB never exhibits the *pre-migration* single-PK schema that I4 must exercise. I4 must therefore **materialize the old schema state itself** rather than rely on the started DB: e.g. open a transaction (or a throwaway/temporary schema/DB), recreate the pre-`004` `player_stats` shape (single `user_id` PK, no `game_type`) and seed a row, then execute the `004` SQL and assert (a) the row now has `game_type = 'big2'`, (b) the PK is composite `(user_id, game_type)`, and (c) no row has a null/empty `game_type`. The implementer owns the exact harness for this (a wrapped transaction that is rolled back, or a dedicated temp schema, keeps it self-contained per testing-principles).

- A3 deliberately records a `'tonk'` result directly via the stats path (state with `gameType: "tonk"`) rather than playing a real Tonk game, so these tests do **not** depend on LLD 65 / the Tonk engine being implemented.

---

## 11. Dependencies

| Dependency | Status | Why |
|------------|--------|-----|
| `supabase/migrations/001_create_tables.sql` | Applied | Defines current `player_stats` (single PK). `004` alters it. **Not edited.** |
| `supabase/migrations/003_increment_stats_rpc.sql` | Applied | Defines current 5-arg RPC. `005` drops + replaces it. **Not edited.** |
| `supabase/migrations/002_enable_rls.sql` | Applied | RLS policy `auth.uid() = user_id` survives unchanged (§3.1). |
| `src/shared/engine-types.ts` (`GameType`, `InternalGameState.gameType`) | Implemented (verified) | Source of the game type at the recording seam (§2.1). No change. |
| `src/backend/service/statsService.ts` | Implemented (LLD 7b) | Pass `state.gameType` to `incrementStats` (§4.4). |
| `src/backend/service/gameService.ts` (call site `:144-148`) | Implemented | Unchanged — already passes the full state to the service (§2.1). |
| `src/backend/database/database.ts` (`PlayerStatsRepository`, `StatsDelta`) | Implemented (LLD 7b) | `gameType` added to signatures; `StatsDelta` unchanged (§4.2). |
| `src/backend/database/entities/PlayerStats.ts` | Implemented | Add `gameType` field (§4.1). |
| `src/backend/database/supabaseDb.ts` (`getStats`/`incrementStats`/`mapPlayerStats`) | Implemented | Add game_type to query/RPC/mapper; add `getAllStats` (§4.3). |
| `src/backend/api/stats/getStats.ts` + `src/shared/model.ts` (`GetStatsResponse`) | Implemented (LLD 7b) | Return per-game breakdown (§4.5). |
| **LLD 65 (Tonk, PR #76)** | Docs, gated | Independent. This LLD supplies the per-game-type dimension LLD 65 §6.3 forward-references; must land before any Tonk game runs in prod (§7.3, §8.4). No code dependency in either direction. |

---

## 12. Open Questions / Escalations

These do not block the design but should be confirmed (most are CEO/product-shaped, one is an implementer precondition):

1. **API breaking change for a contract with no consumer.** `GetStatsResponse` changes from a flat object to `{ userId, games: GameStatsEntry[] }`. Since **no frontend consumes it today** (§6.1), this is a safe, non-breaking-in-practice change. Confirm no out-of-tree consumer (e.g. a manual tool) relies on the flat shape. *(Low risk — recommend proceed.)*
2. **`total_score` semantics across games.** Big2's `total_score` is achievement (higher better); Tonk's is penalty (lower better) per LLD 65 §6.3. Segmenting by game makes each meaningful in isolation, but any **future leaderboard or combined total** must not naively sum/compare across game types. Flagged for whoever designs leaderboards (out of scope here). *(No action now.)*
3. **Backfill precondition (now enforced in-migration, not a manual step):** zero completed non-Big2 games must exist before the backfill (§8.2). This is enforced by `004`'s own `RAISE EXCEPTION` guard (§3.1 step 1 / §8.2), so a violation aborts the migration loudly rather than silently corrupting attribution. Today the precondition holds (Tonk gated); no manual re-check is required because the migration self-checks.

No items required CEO escalation during design: the change cleanly supports the stated product intent (separate Big2/Tonk records) and every customer flow (there is no current stats UX flow to contradict — the only stats surface, the post-match screen, is client-derived and untouched). If the product later wants a *combined* lifetime total surfaced as a headline number, that is a CX decision to route to the CEO, but it is explicitly out of scope here.
