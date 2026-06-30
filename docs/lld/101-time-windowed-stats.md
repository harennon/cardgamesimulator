# LLD 101: Time-windowed stats (lifetime / last 30 days / YTD)

## Scope

Split out of #40. #40 shipped the lifetime stats page against the running-aggregate row the backend already returns. This LLD adds the **backend** ability to slice stats over time windows (lifetime / last 30 days / year-to-date), which the current data model cannot support: `player_stats` is a single running-aggregate row per `(user_id, game_type)` updated in place by `increment_player_stats` (`ON CONFLICT … DO UPDATE SET games_played = games_played + …`). Once a game is folded into the totals, its per-game date/score is lost, so you cannot subtract a date range out of it.

### In scope (this batch, backend-first slice)

1. **New per-game history table** (`game_history`) — one timestamped, append-only row per completed game per registered player: `user_id`, `game_type`, `won`/`lost`, `score`, `played_at`. New migration **010** + co-located post-condition + allowlist/fixture update (migration-safety discipline, LLD 77).
2. **`recordGameCompletion` writes a history row** in addition to (not instead of) the existing `increment_player_stats` aggregate, on the **same** fire-and-forget completion hook and the **same** per-player loop.
3. **`GET /stats` gains an optional `window` param** (`lifetime` | `30d` | `ytd`). Absent or `lifetime` reads the existing aggregate row (unchanged, backwards-compatible). `30d`/`ytd` aggregate from `game_history` with a date filter. The response gains a `trackingSince` field so the client can honestly label windowed views.

### Explicitly NOT in scope

- **The time-range UI selector (step 4 of #40).** Deferred to a follow-up issue. This batch keeps exactly **one** new migration and touches no Vue component. #40's shipped lifetime page must remain pixel-identical and uses the unchanged default code path.
- **Backfill.** Games completed before migration 010 lands have no history rows; windowed views can only show data since the migration. This is a designed-around constraint, not a defect (see Edge Cases).
- **Custom date ranges / weekly / monthly buckets.** Only `lifetime` / `30d` / `ytd`. Custom ranges are a future extension the schema already supports.
- **Guest history.** Guests are skipped today (`recordGameCompletion` already `continue`s on guests); history is registered-users-only, same as the aggregate.
- **Deriving the aggregate from history / dropping the aggregate.** The aggregate row stays as the denormalized fast path for the lifetime view. We do **not** rebuild it from history.

---

## Approach

### A1. Append-only history table, written alongside the aggregate

`game_history` is append-only: one INSERT per registered player per completed game. There is no `ON CONFLICT`, no update-in-place, and no PK collision risk because each completion is a genuinely new row. A surrogate `id UUID` PK avoids any natural-key uniqueness coupling (a player can legitimately complete two games in the same second).

The write rides the **existing** completion hook in `GameService.applyAction` (`recordGameCompletion`, fire-and-forget with a `.catch`). It is added **inside the existing per-player loop** in `recordGameCompletion`, computed from the **same** `gamesWon`/`gamesLost`/`score` values already derived there. This is mandatory: do **not** introduce a second independent write path or a second completion hook that could diverge from the aggregate. The aggregate increment and the history insert are two writes from one loop iteration over the same derived values.

> Note on the known race: the stats write path is already fire-and-forget and racy (the flaky `player-stats` totalScore test). This LLD does **not** fix that and does **not** make it worse — it adds a second write to the same already-racy path. Strict aggregate-vs-history consistency is explicitly a non-goal; both are best-effort and may each independently drop a write under the existing race. Windowed views are derived from history; the lifetime view from the aggregate; they are allowed to differ by a dropped write. (If exact consistency is ever required, the fix is to make the whole hook awaited/transactional — out of scope here and tracked separately.)

### A2. Plain INSERT, not an RPC

The existing `increment_player_stats` is an RPC **because** an upsert-with-increment is a read-modify-write that must be atomic to avoid lost updates. An append-only INSERT has no such hazard — a single `INSERT` is already atomic. So the history write is a **plain PostgREST insert** via the service-role client, not a new stored procedure. This is simpler (no new function signature, no grant/overload hazards, no `SECURITY DEFINER`), and it sidesteps the entire class of RPC-overload bugs that bit LLD 66. **Recommended.**

> Alternative considered — a `record_game_history` RPC mirroring `increment_player_stats`. Rejected: it adds a function-signature artifact and a post-condition arity check for zero benefit, since the insert needs no atomicity guarantee the table doesn't already give.

### A3. Windowed aggregation in SQL via a date-filtered RPC; lifetime stays on the aggregate

- `window` absent or `lifetime` → **unchanged**: `getAllStats(userId)` reads `player_stats`. Zero behavior change for current clients (#40's page sends no `window`).
- `window = 30d` / `ytd` → a new repo method aggregates `game_history` rows for the user with a `played_at >= <cutoff>` filter, grouped by `game_type`, returning the same shape (`gamesPlayed`/`gamesWon`/`gamesLost`/`totalScore` + derived `winRate`).

The windowed aggregation is done in **SQL** (a `SECURITY DEFINER` read-only RPC `get_windowed_stats(p_user_id, p_since)` that returns the grouped counts), not by pulling all rows into Node and summing. Rationale: keeps the row volume on the DB, returns the same compact shape the handler already maps, and the cutoff is computed in the backend (a `Date`) and passed as a parameter so the SQL is window-agnostic. The cutoff math (30 days ago; Jan 1 of the current year, UTC) lives in the **backend** so it is unit-testable as a pure function and the SQL stays a dumb date filter.

> Alternative considered — filtered `select` + aggregate in JS. Acceptable and simpler to test, but pulls N rows per user over the window and re-implements grouping in TS. For a stats screen this volume is tiny, so this is a **viable fallback** if the implementer prefers to avoid a second RPC; the LLD permits either, but recommends the RPC for symmetry with the existing stats RPC and to keep aggregation server-side (architecture-principles #1, server-authoritative). Whichever is chosen, the **cutoff is computed in the backend**, never in SQL (`now() - interval`), so the window boundary is deterministic and testable.

### A4. `trackingSince` — honest labeling, no fabrication

Because there is no backfill, a windowed view can only reflect games since 010 landed. The handler returns `trackingSince`: the earliest `played_at` in `game_history` for that user (per response, across all their game types), or `null` if they have no history rows yet. The UI follow-up (#40 step 4) uses this to render "tracking since <date>" so a user with a long pre-migration lifetime record is not misled into thinking a sparse 30d/YTD window is their whole story. The backend never extrapolates or fabricates pre-migration per-game data.

### A5. Migration-safety discipline (mandatory — this is why the issue is unblocked)

Migration 010 ships with **all** of:
- A co-located `postconditions/010_*.postcondition.sql` (the post-condition runner asserts 1:1 coverage; a missing file fails CI).
- An entry in `supabase/migrations/expected-diff.allowlist.json` `expectedPending`, **and** a matching entry in `scripts/fixtures/clean-diff.json` `pending` in the **same PR**. Updating one without the other fails the drift gate `Stale expectedPending` / `Pending migration(s) missing from expectedPending` (this reddened PR #107 — see drift-gate `evaluateDriftGate`).
- **Name-agnostic SQL**: no hardcoded constraint/PK/index names in either the migration or the post-condition. Assert shape (column presence + type, grant set), never an artifact name. (The LLD 66 incident was a hardcoded `player_stats_pkey` that no-op'd against prod's TypeORM-era `player_stats_pkey1`.) `CREATE TABLE … (… PRIMARY KEY)` inline, no named constraint; `CREATE INDEX IF NOT EXISTS` is fine (a fresh object, not a drift target).
- Verified against the **prod-shaped fixture** (`tests/integration/helpers` per LLD 77 §7) and the local `supabase start` DB, not just a fresh start. `game_history` is a brand-new table, so it is immune to the `*_pkey1` PK-name drift class — but the post-condition and grant assertions must still hold against the prod-shaped baseline.

This is a **distinct table**. It must not be folded into, or conflict with, any `player_stats` aggregate migration. `player_stats` is untouched by 010.

---

## Interfaces / Types

### Migration 010 — `010_create_game_history.sql` (shape, name-agnostic)

```sql
-- 010: per-game history. One append-only row per completed game per registered
-- player. Enables time-windowed stats (lifetime/30d/ytd) that a running
-- aggregate cannot slice. player_stats (the lifetime fast path) is untouched.
-- Brand-new table => immune to the TypeORM-era PK-name drift; PK is an inline,
-- UNNAMED surrogate so no hardcoded constraint name (LLD 66 lesson).
CREATE TABLE IF NOT EXISTS game_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,            -- Supabase auth.users.id; no FK (different schema), mirrors player_stats
  game_type  VARCHAR(50) NOT NULL,
  won        BOOLEAN NOT NULL,
  lost       BOOLEAN NOT NULL,
  score      INT NOT NULL,
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Windowed queries filter by user + date; group by game_type.
CREATE INDEX IF NOT EXISTS idx_game_history_user_played
  ON game_history (user_id, game_type, played_at);

-- Grants mirror the CLEANED 001/008 end-state: service_role full; anon/authenticated
-- SELECT-only (no write DML to anon). RLS to be enabled in the same migration if
-- the implementer follows the 002 pattern; backend uses service_role and bypasses RLS.
GRANT ALL ON game_history TO service_role;
GRANT SELECT ON game_history TO authenticated;
GRANT SELECT ON game_history TO anon;
```

> `won`/`lost` are stored as two booleans (not a single placement int) to match exactly what `recordGameCompletion` already derives (`gamesWon`/`gamesLost`, which are loss-centric for Tonk and winner-centric for Big2). This keeps the write a 1:1 mapping of values already computed and avoids re-deriving placement. `score` carries the per-game placement score.

### Optional RPC — `get_windowed_stats` (if A3-RPC chosen)

```sql
CREATE OR REPLACE FUNCTION get_windowed_stats(p_user_id UUID, p_since TIMESTAMPTZ)
RETURNS TABLE (game_type VARCHAR, games_played BIGINT, games_won BIGINT,
               games_lost BIGINT, total_score BIGINT) AS $$
  SELECT game_type, count(*), count(*) FILTER (WHERE won),
         count(*) FILTER (WHERE lost), coalesce(sum(score), 0)
  FROM game_history
  WHERE user_id = p_user_id AND played_at >= p_since
  GROUP BY game_type;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
-- Same grant discipline as increment_player_stats: REVOKE from PUBLIC/anon/
-- authenticated, GRANT EXECUTE to service_role only.
```

If the RPC is added, it needs its own post-condition (visible, 1-overload, correct arity) per the 005 post-condition idiom. If the JS-aggregation fallback (A3) is chosen instead, no RPC and no extra post-condition — only the table post-condition.

### Repository (`PlayerStatsRepository`, `src/backend/database/database.ts`)

```typescript
export interface GameHistoryRow {
  userId: string;
  gameType: GameType;
  won: boolean;
  lost: boolean;
  score: number;
}

export interface PlayerStatsRepository {
  getStats(userId: string, gameType: GameType): Promise<PlayerStats | null>;
  getAllStats(userId: string): Promise<PlayerStats[]>;          // unchanged — lifetime fast path
  incrementStats(userId: string, gameType: GameType, delta: StatsDelta): Promise<void>; // unchanged

  /** Append one completed-game row. Plain INSERT (append-only, atomic). */
  recordGameHistory(row: GameHistoryRow): Promise<void>;

  /** Aggregate game_history for a user since `since`, grouped by game_type.
   *  Returns the same per-game-type shape getAllStats does (counts only). */
  getWindowedStats(userId: string, since: Date): Promise<PlayerStats[]>;

  /** Earliest played_at across all of the user's history rows, or null. */
  getTrackingSince(userId: string): Promise<Date | null>;
}
```

### Shared model (`src/shared/model.ts`)

```typescript
export type StatsWindow = "lifetime" | "30d" | "ytd";

export interface GetStatsResponse {
  userId: string;
  window: StatsWindow;            // echoes the resolved window (default "lifetime")
  trackingSince: string | null;   // ISO 8601; earliest history row, null if none / lifetime path
  games: GameStatsEntry[];        // GameStatsEntry shape UNCHANGED
}
```

`GameStatsEntry` is unchanged. For `30d`/`ytd`, `lastPlayedAt` is the max `played_at` within the window for that game type (or null); `winRate` is derived in the handler exactly as today.

### API — `GET /stats` (`src/backend/api/stats/getStats.ts`)

- Read optional query param `window`. Validate against `StatsWindow`; **unknown/malformed → 400** (or treat as `lifetime`; recommend 400 to surface client bugs — see Edge Cases E5). Absent → `lifetime`.
- `lifetime`: `getAllStats(userId)` (unchanged mapping). `trackingSince` = `null` (the lifetime path does not consult history; documented).
- `30d`/`ytd`: compute `since` (pure helper, below), call `getWindowedStats(userId, since)`, map identically, and call `getTrackingSince(userId)` for the label.

### Cutoff helper (pure, backend)

```typescript
// Pure, UTC, unit-testable. `now` injected for deterministic tests.
export function windowCutoff(window: StatsWindow, now: Date): Date | null {
  // "lifetime" -> null (no filter)
  // "30d"      -> now - 30*24h
  // "ytd"      -> Jan 1 00:00:00.000Z of now's UTC year
}
```

---

## State Model

- **`player_stats` (existing, persisted):** running aggregate per `(user_id, game_type)`. Unchanged. Sole source for the `lifetime` view. Denormalized fast path.
- **`game_history` (new, persisted):** append-only per-completion rows. Source for `30d`/`ytd` views and for `trackingSince`. Never read on the gameplay hot path.
- **In-memory:** none. Stats are a cold-path read (REST), not part of the in-memory active-game cache (architecture-principles #5). The completion write rides the existing fire-and-forget hook off the hot path.
- **Write flow:** `GameService.applyAction` detects `status === "COMPLETED"` → `recordGameCompletion(state)` (fire-and-forget). Inside its existing per-player loop, for each non-guest player it (a) `incrementStats` (existing) **and** (b) `recordGameHistory` (new), from the same derived `gamesWon`/`gamesLost`/`score`. Per-player failures are caught and logged (existing pattern); a history-insert failure must not block the aggregate increment or other players (same try/catch granularity as today — wrap the two writes so one failing does not skip the other).
- **Read flow:** `GET /stats?window=…` → handler resolves window → repo (`getAllStats` for lifetime; `getWindowedStats` + `getTrackingSince` for windowed) → maps to `GameStatsEntry[]` → JSON. No engine, no cache.

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| E1 | **No backfill — user has lifetime history but no/sparse pre-010 windowed data.** | Windowed views reflect only post-010 rows. Response carries `trackingSince` (earliest history row) so the UI can render "tracking since <date>". Never fabricate or extrapolate. |
| E2 | **User has zero history rows (new, or never completed a game post-010), `window=30d/ytd`.** | `getWindowedStats` returns `[]`; `getTrackingSince` returns `null`. Response: `games: []`, `trackingSince: null`. Same empty-state the lifetime path produces for a brand-new user. |
| E3 | **Guest player in a completed game.** | Skipped — `recordGameCompletion` already `continue`s on guests before any write. No history row, no aggregate row. Unchanged. |
| E4 | **History insert fails (DB error) but aggregate increment succeeds (or vice-versa).** | Best-effort, fire-and-forget. Each write is caught/logged independently so one failing does not skip the other or block other players. Aggregate (lifetime) and history (windowed) may diverge by a dropped write under the existing race; this is accepted (see A1). |
| E5 | **`window` param is unknown / malformed (e.g. `?window=lastweek`).** | Reject with **400** (recommended) rather than silently defaulting, to surface client bugs. Empty/absent is valid and means `lifetime`. |
| E6 | **`ytd` early in January / across year boundary.** | Cutoff is Jan 1 00:00:00Z of `now`'s UTC year. A game played Dec 31 is excluded from January's YTD. Deterministic via injected `now` in `windowCutoff`. Document UTC explicitly; do not use local server time. |
| E7 | **`30d` boundary game played exactly 30 days ago.** | Filter is `played_at >= now - 30d` (inclusive lower bound). Specify inclusive so the boundary is testable and unambiguous. |
| E8 | **Loss-centric (Tonk) vs winner-centric (Big2) games.** | `won`/`lost` written from the same `gamesWon`/`gamesLost` `recordGameCompletion` already derives (loss-centric branch for Tonk, winner branch for Big2). The history row is a 1:1 record of those values; no re-derivation. |
| E9 | **A game with multiple losers / no winner edge in the engine.** | Out of engine scope here — `recordGameCompletion` consumes whatever `scores`/`breakdown`/`winner` the engine produced. History faithfully records the per-player `won`/`lost`/`score` already computed; it adds no new game-rule logic. |
| E10 | **Prod-shaped fixture drift (TypeORM-era).** | `game_history` is new, so no `*_pkey1` PK-name drift applies. Post-condition still asserts table presence, column types, and the cleaned grant set against the prod-shaped fixture (LLD 77 §7), not only a fresh `supabase start`. |

---

## Dependencies

| Dependency | Status | Why |
|------------|--------|-----|
| `src/backend/service/statsService.ts` (`recordGameCompletion`) | Shipped | The single completion hook the history write rides; per-player loop and `gamesWon`/`gamesLost`/`score` derivation are reused as-is. |
| `src/backend/service/gameService.ts` (fire-and-forget completion hook, ~L232) | Shipped | The call site; unchanged — it still calls `recordGameCompletion`. |
| `src/backend/database/database.ts` / `supabaseDb.ts` (`PlayerStatsRepository`) | Shipped | Extended with `recordGameHistory` / `getWindowedStats` / `getTrackingSince`; existing methods untouched. |
| `src/backend/api/stats/getStats.ts` | Shipped | Gains the optional `window` param; lifetime branch unchanged. |
| `src/shared/model.ts` (`GetStatsResponse`, `GameStatsEntry`) | Shipped | `GetStatsResponse` gains `window` + `trackingSince`; `GameStatsEntry` unchanged (preserves #40's page). |
| LLD 77 harness: `expected-diff.allowlist.json`, `scripts/fixtures/clean-diff.json`, `scripts/verify-drift.mjs`, `scripts/verify-postconditions.mjs`, prod-shaped fixture | Shipped | Migration 010 + post-condition + allowlist/fixture entries plug into these. Both `expectedPending` and the fixture `pending` array updated in the same PR (drift-gate stale-allowlist rule). |
| LLD 66 / migration 005 post-condition idiom | Shipped | Pattern for the (optional) RPC post-condition (visible / 1-overload / arity). |
| #40 stats page | Shipped | The lifetime view this batch must not regress. The `window` UI selector (step 4) is a **downstream** follow-up issue, not this batch. |

No CEO escalation. The CX doc describes a stats screen; the time-range selector it implies is deferred to the #40-follow-up UI issue, consistent with the backend-first selection. No CX conflict.

---

## Test Requirements

Per testing-principles: self-contained, deterministic, no shared `beforeEach` state, run the real SQL (no mocks of migrations).

### Unit

- **`windowCutoff(window, now)`** (pure): `lifetime` → null; `30d` → exactly `now − 30d`; `ytd` → Jan 1 00:00:00.000Z of `now`'s UTC year. Cover the Jan-boundary (E6) and a mid-year date with a fixed injected `now`. UTC, not local.
- **`recordGameCompletion` writes both** (extend `tests/service/statsService.test.ts`): for a completed game with registered players, assert `incrementStats` **and** `recordGameHistory` are each called once per non-guest player, with `won`/`lost`/`score` matching the derived values. Cover the Big2 winner-centric branch and the Tonk loss-centric branch (E8). Assert guests trigger **neither** call (E3).
- **`recordGameCompletion` failure isolation** (E4): a `recordGameHistory` that rejects does not prevent `incrementStats` for the same player, nor processing of other players; errors are caught/logged. And vice-versa.
- **`GET /stats` window resolution:** absent/`lifetime` → `getAllStats` path, no history calls, `trackingSince: null`. `30d`/`ytd` → `getWindowedStats` called with the correct cutoff and `getTrackingSince` called. Unknown `window` → 400 (E5).

### Integration (against `supabase start` + prod-shaped fixture)

- **Migration 010 + post-condition:** apply 010 via the post-condition runner / prod-shaped fixture; assert `game_history` exists with the expected columns + types and the cleaned grant set (anon SELECT-only, no write DML), against **both** a fresh start and the prod-shaped baseline (E10). Assert the runner's 1:1 coverage passes (010 has its post-condition; RPC has its own if added).
- **Drift gate:** `verify:drift --diff-file scripts/fixtures/clean-diff.json` passes with `010_*` added to both `expectedPending` and the fixture `pending` array; assert it would **fail** if only one is updated (stale-allowlist regression — guards the PR #107 footgun).
- **Append-only insert:** `recordGameHistory` inserts a new row each call (two completions in the same second produce two rows — surrogate PK, no collision).
- **Windowed aggregation correctness:** seed `game_history` rows at known `played_at` timestamps (direct state insertion, not replayed games) straddling the 30d and YTD cutoffs; assert `getWindowedStats(userId, since)` returns the correct grouped counts and excludes rows outside the window. Cover the inclusive `>=` boundary (E7) and the empty-result case (E2).
- **`getTrackingSince`:** returns the earliest `played_at`; `null` when the user has no rows.

### Security

- **No anon writes to `game_history`:** post-condition asserts anon holds SELECT and none of INSERT/UPDATE/DELETE (mirror 001/008 `has_table_privilege` assertions). If the RPC is added, assert it is service_role-only (REVOKE from PUBLIC/anon/authenticated), matching `increment_player_stats`.
- **No cross-user leakage:** `getWindowedStats`/`getTrackingSince` filter by `user_id`; a request for user A never returns user B's rows. The handler uses `request.userId` (server-trusted), never a client-supplied id.

### Out of scope for automated tests

- Live-prod `--linked` diff and the prod-side post-condition run after `supabase db push` — human-owned release steps (LLD 77 §9).
- The time-range UI selector — deferred follow-up issue.
