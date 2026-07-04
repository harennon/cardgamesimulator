# LLD 149: game_history retention policy — prune the unbounded append-only table

## Scope

`game_history` (migration 010, LLD 101) is the app's first unbounded-growth table:
one append-only row per registered player per completed game, with no TTL and no
cleanup. Windowed stats read it; nothing ever removes rows. This LLD adds a
**periodic age-based prune** so the table stays bounded well inside the Supabase
free-tier 500 MB disk cap.

### In scope

1. A new migration **011** that creates:
   - A `prune_game_history()` SQL function that DELETEs rows older than a fixed
     retention floor (13 months), returning the number of rows deleted.
   - A scheduled invocation of that function via **Supabase Cron (pg_cron)** —
     daily.
2. Co-located post-condition `011_*.postcondition.sql` asserting the function
   exists with the correct grant discipline, the cron job is registered, and —
   critically — that a prune run does **not** change `player_stats` aggregates.
3. Migration-safety wiring in the **same PR**: `expected-diff.allowlist.json`
   `expectedPending`, `scripts/fixtures/clean-diff.json` `pending`, and a
   `destructive-ddl.allowlist.json` entry permitting the one `DELETE` inside the
   function body.
4. Documented free-tier headroom (sizing table + retention rationale).

### Explicitly NOT in scope

- **Monthly-summary rollup of aged rows.** The issue offers this as an
  alternative only if a longer-than-YTD window is ever added. No such window
  exists (`windowCutoff` supports only `lifetime`/`30d`/`ytd`), so building the
  rollup now is speculative (CLAUDE.md §2 Simplicity First). Deferred; the
  DELETE-by-age policy is a superset-safe stepping stone if it is ever needed.
- **Touching `player_stats`.** The lifetime aggregate is the source of truth for
  all-time stats and is bounded (one row per user × game_type). It is never a
  prune candidate. This is a hard constraint (see Edge Cases E1).
- **Backend/TypeScript changes.** The prune runs entirely in-database on a
  schedule; no Express code, no repository method, no API surface. `getStats`,
  `recordGameHistory`, `getWindowedStats`, `getTrackingSince` are all unchanged.
- **Backfill / one-time bulk cleanup.** At current volume there is nothing to
  prune yet; the scheduled job reaching steady state is sufficient.
- **Retention tuning UI / configurability.** The floor is a fixed interval
  literal in the migration.

---

## Approach

### A1. Retention floor = 13 months, never touching any readable window

The longest supported window is **YTD** (`windowCutoff` → Jan 1 00:00:00Z of the
current UTC year). On Dec 31, YTD reaches back ~12 months; on Jan 1 it reaches
back a fraction of a day. The prune must never delete a row any live window still
reads, so the floor must exceed the largest reach of YTD **plus margin**:

- **Floor: `INTERVAL '13 months'`.** `DELETE ... WHERE played_at < now() - INTERVAL '13 months'`.
- On any day of the year, the oldest row YTD could read is Jan 1 of the current
  year, i.e. at most ~12 months old (on Dec 31). 13 months leaves a full month of
  margin so a boundary/clock-skew case can never truncate YTD. The `30d` window
  is trivially covered.

This is the conservative interpretation the issue mandates (≥13 months). Using a
13-month floor (not exactly 12) means the prune is provably window-safe without
depending on the exact day the job runs.

> **Why an interval literal in SQL, not a backend-computed cutoff.** LLD 101
> deliberately computes the *stats* cutoff in the backend so the read query stays
> window-agnostic and unit-testable. The prune is the opposite: it is a fixed
> data-lifecycle policy with a single hard-coded floor, invoked by the database's
> own scheduler with no backend in the loop. `now() - INTERVAL '13 months'`
> in-DB is correct here and keeps the mechanism self-contained (no Node process,
> no network, no cron-on-a-host to keep alive — architecture-principles #10,
> deploy cheap).

### A2. Mechanism: a SQL function + Supabase Cron (pg_cron), daily

**Recommended.** Supabase provides **Supabase Cron** (the managed `pg_cron`
extension) on all plans including Free; jobs can run from every second to once a
year and are stored in `cron.job`. This is the lightest option that fits the
current infra: no new host, no Railway worker, no backend timer that dies on
restart.

- Migration 011 defines `prune_game_history()` (a `SECURITY DEFINER` function so
  the scheduled job — which runs as the `postgres`/cron role — can DELETE
  regardless of the invoking role's table grants, matching the
  `increment_player_stats` idiom).
- Migration 011 registers a daily cron job (e.g. `'5 4 * * *'`, 04:05 UTC — off
  the app's busy hours) that calls `SELECT prune_game_history();`.
- Registration is idempotent: use `cron.schedule('prune-game-history', …)`
  (re-scheduling the same job name updates in place, so re-applying the migration
  does not create duplicate jobs). Guard the whole block on `pg_cron` being
  available; the `CREATE EXTENSION IF NOT EXISTS pg_cron` line is owned by the
  Supabase platform (already present on the project), so the migration should
  reference `cron.schedule` and, if `CREATE EXTENSION` is required locally,
  wrap it so `supabase start` (which may not pre-load pg_cron) still applies the
  migration — see Edge Cases E4.

**Frequency:** daily. The table is tiny relative to the cap for years; even
weekly would suffice. Daily keeps the per-run delete set small (bounded by one
day of new rows aging past 13 months) so no run ever does a large scan/delete.

> **Alternative considered — a backend cron / Railway scheduled task calling a
> repository `pruneGameHistory()` method.** Rejected: adds a TS code path, a new
> repo method + its tests, and a host-side scheduler that must stay running and
> survive restarts — more moving parts for a policy that is pure data lifecycle.
> The issue asks for "the lightest option that fits the current infra"; an
> in-database scheduled function has zero backend footprint. Kept as a fallback
> only if the target project cannot enable pg_cron (see E4).

> **Alternative considered — partitioning `game_history` by month and DROPping
> old partitions.** Rejected as over-engineered at this scale (CLAUDE.md §2): it
> requires a schema migration of the live table and ongoing partition
> maintenance, for a table that is ~10–100 MB even at healthy traffic. Revisit
> only if delete-based pruning ever shows bloat/vacuum pressure.

### A3. Idempotent and fail-safe

- **Idempotent:** the DELETE is `WHERE played_at < now() - INTERVAL '13 months'`.
  Running it twice in a row deletes nothing the second time (the first run
  already removed everything past the floor); running it N times/day is
  harmless. `cron.schedule` by job name is itself idempotent on re-apply.
- **Fail-safe:** a single DELETE statement is atomic — it either commits fully or
  rolls back; there is no partial-delete state. A failed run (lock timeout, brief
  outage) simply leaves rows in place until the next scheduled run picks them up.
  The function only ever touches `game_history`; a bug or failure cannot corrupt
  `player_stats` because that table is never referenced (E1).
- **Observable:** the function `RETURNS bigint` (rows deleted) and `RAISE
  NOTICE`s the count. `pg_cron` records every run and its status in
  `cron.job_run_details`, so runs are inspectable without adding app logging.

### A4. Migration-safety discipline (mandatory)

Migration 011 is a **data-deleting** migration, so it must clear both gates that
guard the automated prod `db push` (#91):

1. **Destructive-DDL gate** (commit e85f957, `scripts/verify-no-destructive-ddl.mjs`).
   The scanner bans `DELETE FROM` / `TRUNCATE` in any `supabase/migrations/*.sql`
   unless allowlisted per-file + per-op. **The scanner treats dollar-quoted
   `$$…$$` function bodies as live SQL** (it explicitly does not neutralize
   them), so the `DELETE FROM game_history` inside `prune_game_history()`'s body
   **will be flagged**. This is correct and intended: the prune is a genuine,
   reviewed data-deletion. Add an entry to
   `supabase/migrations/destructive-ddl.allowlist.json`:
   `"011_prune_game_history.sql": ["DELETE"]`, with a `$comment`-style rationale
   noting it is the retention prune, bounded to rows > 13 months old, and never
   touches `player_stats`. Do **not** loosen the gate globally.
2. **Drift gate** (`scripts/verify-drift.mjs` + `scripts/lib/drift-gate.mjs`).
   Add `011_prune_game_history.sql` to **both** `expected-diff.allowlist.json`
   `expectedPending` **and** `scripts/fixtures/clean-diff.json` `pending`, in the
   **same PR**. Updating one without the other fails the gate with
   `Stale expectedPending` / `Pending migration(s) missing from expectedPending`
   (this reddened PR #107 — drift-gate fixture coupling).
3. **Post-condition coverage** (`scripts/verify-postconditions.mjs`) asserts 1:1
   coverage: `011_*.sql` must have `postconditions/011_*.postcondition.sql` or CI
   fails the coverage check.
4. **Name-agnostic SQL:** assert shape (function presence, grant set, cron job
   presence), never a hardcoded constraint/index name (LLD 66 lesson). `game_history`
   is a fresh table immune to the TypeORM-era `*_pkey1` drift class.

The consuming order is the standard release sequence (DEVELOPMENT.md §Prod
Migration Release): `supabase db push` → `verify-postconditions.mjs` → deploy.
There is no backend to deploy for this LLD, so step 3 (deploy) is a no-op.

---

## Interfaces / Types

No TypeScript interfaces change. The entire change is SQL. Shapes below are the
implementable spec.

### Migration `011_prune_game_history.sql` (shape, name-agnostic)

```sql
-- 011: retention prune for game_history (LLD 149). game_history (010) is
-- append-only and unbounded; windowed stats never read past YTD, so rows older
-- than the longest window + margin are dead weight against the 500 MB free-tier
-- cap. This DELETEs rows older than 13 months (YTD max reach ~12 months + 1
-- month margin => a live window can never read a pruned row). player_stats (the
-- lifetime aggregate) is NEVER referenced here and is not a prune candidate.

-- Fixed retention floor. Interval literal (not a backend param): this is a
-- data-lifecycle policy invoked by the DB scheduler with no backend in the loop.
CREATE OR REPLACE FUNCTION prune_game_history()
RETURNS bigint AS $$
DECLARE
  deleted bigint;
BEGIN
  DELETE FROM game_history
  WHERE played_at < now() - INTERVAL '13 months';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RAISE NOTICE 'prune_game_history: deleted % row(s) older than 13 months', deleted;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Same grant discipline as increment_player_stats / get_windowed_stats: only the
-- backend/scheduler context may execute it. REVOKE from PUBLIC first.
REVOKE EXECUTE ON FUNCTION prune_game_history FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prune_game_history FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_game_history TO service_role;

-- Schedule daily via Supabase Cron (pg_cron). Idempotent: re-scheduling the same
-- job name updates it in place, so re-applying this migration never duplicates
-- the job. Guarded so the migration still applies where pg_cron is absent (E4).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'prune-game-history',           -- stable job name (idempotent upsert)
      '5 4 * * *',                    -- 04:05 UTC daily, off busy hours
      $cron$ SELECT prune_game_history(); $cron$
    );
  ELSE
    RAISE NOTICE 'pg_cron not present; prune_game_history created but not scheduled (enable Supabase Cron on this project).';
  END IF;
END $$;
```

> Notes for the implementer:
> - Use a distinct dollar-quote tag (`$cron$`) for the scheduled command so it
>   nests inside the outer `$$` DO block cleanly.
> - The scheduled command string contains `SELECT prune_game_history();` — this
>   is inside a **string literal** (`$cron$…$cron$`), which the destructive-DDL
>   scanner neutralizes; only the literal `DELETE FROM game_history` in the
>   function body needs the allowlist entry. Verify with `npm run
>   verify:no-destructive-ddl` that exactly one `DELETE` is reported for this file.

### Migration-safety files (same PR)

- `supabase/migrations/destructive-ddl.allowlist.json` — add
  `"011_prune_game_history.sql": ["DELETE"]`.
- `supabase/migrations/expected-diff.allowlist.json` — append
  `"011_prune_game_history.sql"` to `expectedPending`.
- `scripts/fixtures/clean-diff.json` — append `"011_prune_game_history.sql"` to
  `pending` (must mirror `expectedPending`).

### Post-condition `postconditions/011_prune_game_history.postcondition.sql` (shape)

Shape-based, idempotent, read-only. Asserts:

1. `prune_game_history` is exactly one visible function, `SECURITY DEFINER`,
   `EXECUTE` granted to `service_role` and REVOKED from anon/authenticated/PUBLIC
   (mirror the 003 post-condition idiom).
2. The cron job named `prune-game-history` exists in `cron.job` (**skip this
   assertion when `pg_cron` is absent**, e.g. a bare `supabase start` — see E4 —
   so local coverage still passes; the assertion is enforced against prod where
   Cron is enabled).
3. **`player_stats` is unchanged by a prune** (the acceptance-criterion
   machine-check): snapshot the `player_stats` aggregate totals, invoke
   `SELECT prune_game_history();`, then assert the snapshot is byte-for-byte
   unchanged. Because a post-condition runs against a DB that has *only* the
   migrated schema (no ≥13-month-old rows in a fresh/CI DB), this run deletes 0
   rows and proves the function does not write `player_stats` on any path. RAISE
   if any `player_stats` row's `(games_played, games_won, games_lost,
   total_score, last_played_at)` differs after the call.

```sql
-- sketch of assertion 3
-- 1. capture: SELECT array_agg(... ORDER BY user_id, game_type) FROM player_stats
-- 2. PERFORM prune_game_history();
-- 3. re-capture and RAISE EXCEPTION if the two arrays differ
```

> This post-condition is the only place the prune function is *invoked* in a test
> context; it doubles as the fail-safe proof that pruning cannot mutate the
> lifetime aggregate.

---

## State Model

- **`game_history` (existing, persisted):** append-only rows. Now has a bounded
  effective lifetime of ≤13 months of history at rest, enforced by the daily
  prune. Still written on the existing fire-and-forget completion hook (LLD 101);
  that write path is unchanged.
- **`player_stats` (existing, persisted):** running lifetime aggregate.
  **Untouched** by this LLD in every dimension — no schema change, no read, no
  write from the prune. Remains the source of truth for the `lifetime` view.
- **`cron.job` / `cron.job_run_details` (pg_cron, persisted):** hold the schedule
  and each run's status. Read-only observability surface for the prune.
- **In-memory:** none. The prune is a cold-path, in-database scheduled job with
  no backend process and no interaction with the in-memory active-game cache
  (architecture-principles #5).
- **Flow:** pg_cron fires daily → `SELECT prune_game_history()` →
  single atomic `DELETE` of rows with `played_at < now() - 13 months` → row count
  logged to `cron.job_run_details` and via `RAISE NOTICE`. No client, no API, no
  engine.
- **Read impact:** none. `getWindowedStats`/`getTrackingSince`/`get_windowed_stats`
  only ever read rows inside the 13-month floor (30d and YTD are both < 13
  months), so pruned rows were never readable by any query. `getTrackingSince`
  after steady state returns the earliest *retained* row (≥ ~13 months ago),
  which is the honest "tracking since" for a windowed view — see E5.

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| E1 | **Prune must never affect `player_stats`.** | `prune_game_history()` references only `game_history`. The post-condition invokes it and asserts `player_stats` aggregates are byte-for-byte unchanged (machine-checkable acceptance criterion). Hard constraint. |
| E2 | **Prune must never delete a row a live window still reads.** | Floor is 13 months; YTD's max reach is ~12 months (Dec 31), 30d is 1 month. Deleted rows (`played_at < now() − 13 months`) are strictly older than anything any window reads. 1-month margin covers year-boundary/clock edge. |
| E3 | **Re-running / running multiple times a day (idempotency).** | DELETE-by-age is naturally idempotent — the second run in the same window finds no rows past the floor. `cron.schedule` by stable job name updates in place, so re-applying migration 011 never creates a duplicate job. |
| E4 | **`pg_cron` not available on the target (e.g. bare `supabase start`, or a project without Supabase Cron enabled).** | The `cron.schedule` call is guarded by `IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron')`; when absent, the migration still creates the function and only skips scheduling (`RAISE NOTICE`). The post-condition's cron-job assertion is likewise skipped when pg_cron is absent, so CI coverage passes; scheduling is enforced against prod, where Supabase Cron is enabled. **Human release step:** confirm Supabase Cron is enabled on the prod project before/at `db push`; if the platform requires `CREATE EXTENSION pg_cron` via the dashboard, that is a one-time human action documented in the release notes. |
| E5 | **`getTrackingSince` after steady-state pruning.** | Returns the earliest *retained* `played_at` (~13 months ago) rather than the user's true first game. This is acceptable and honest: `trackingSince` labels how far back windowed data reaches, and no window reads past 13 months anyway. Lifetime stats (from `player_stats`) are unaffected, so all-time totals still reflect the user's full record. |
| E6 | **A single prune run's delete set is unexpectedly large (e.g. first run after enabling on a table that grew for >13 months without pruning).** | Not a concern now (table is <13 months old, so the first steady-state runs delete ~0). If pruning is enabled late on a large table, the first DELETE is still atomic and bounded by the DB; if it ever caused lock/vacuum pressure, batching the delete (LIMIT + loop) is a follow-up — not built speculatively. |
| E7 | **Fixed 13-month floor documented but never revisited if a longer window is added later.** | If a window longer than YTD is ever introduced (`windowCutoff` gains a case), the floor must be raised to exceed it + margin **before** that window ships, or switch to the monthly-summary rollup (out of scope here). Called out in the migration comment and here as the guardrail. |
| E8 | **Timezone of the interval.** | `now()` is `timestamptz`; `played_at` is `timestamptz` (010). The comparison is instant-based (UTC under the hood), consistent with LLD 101's UTC discipline. `INTERVAL '13 months'` is calendar-months arithmetic on the instant, which only widens the safety margin. |

---

## Dependencies

| Dependency | Status | Why |
|------------|--------|-----|
| Migration 010 (`game_history` table + index) | Shipped, **live in prod** | The table this prunes. Prune reads/deletes only `game_history`. |
| `src/backend/api/stats/windowCutoff.ts` | Shipped | Defines the longest supported window (YTD) the 13-month floor must exceed. Read-only reference; not modified. |
| Destructive-DDL gate: `scripts/lib/destructive-ddl.mjs`, `scripts/verify-no-destructive-ddl.mjs`, `supabase/migrations/destructive-ddl.allowlist.json`, `ci.yml` step | Shipped (commit e85f957) — **not yet on this branch** | Migration 011's in-body `DELETE` must be allowlisted here or CI's Destructive-DDL gate fails. Branch was cut before e85f957; the implementer must rebase onto/merge current `main` (which carries the gate) so the allowlist entry has something to satisfy. |
| Drift gate: `scripts/verify-drift.mjs`, `scripts/lib/drift-gate.mjs`, `expected-diff.allowlist.json`, `scripts/fixtures/clean-diff.json` | Shipped | 011 must be added to both `expectedPending` and fixture `pending` in the same PR (stale-allowlist rule, PR #107 footgun). |
| Post-condition runner: `scripts/verify-postconditions.mjs` | Shipped | Enforces 1:1 coverage; 011 needs its co-located post-condition. |
| Post-condition idiom from 003/005 (function presence + `SECURITY DEFINER` + grant set) | Shipped | Pattern for 011's function assertions. |
| Supabase Cron (`pg_cron`) enabled on the prod project | **Human release step** | Scheduling requires the extension. Available on Free tier; may need one-time enable via the dashboard. Verified available per Supabase compute/cron docs. |
| Release sequence (DEVELOPMENT.md §Prod Migration Release) | Shipped | `db push` → `verify-postconditions.mjs` (against prod, pooler + `PGSSLMODE=no-verify`) → (no backend deploy for this LLD). |

No CEO escalation. This is a pure infrastructure/data-lifecycle change with no CX
surface; `docs/customer-experience.md` describes no history-retention behavior and
lifetime stats are unaffected. No CX conflict.

---

## Free-tier headroom (documented per acceptance criteria)

- **Free-tier cap: 500 MB database/disk (Supabase Nano compute).** Confirmed
  against current Supabase docs (Compute and Disk: Nano = up to 0.5 GB RAM,
  **500 MB** disk). The issue's ~500 MB is correct.
- **Row size:** ~120–150 bytes all-in per `game_history` row (7 columns + index),
  per the issue's sizing.
- **Bounded size with a 13-month prune** (steady state = at most ~13 months of
  rows retained):

  | Volume | Rows/yr | ~13-month resident set | ~Size at rest | % of 500 MB |
  |---|---|---|---|---|
  | 50 games/day | ~73 K | ~79 K | ~11 MB | ~2% |
  | 500 games/day | ~730 K | ~790 K | ~110 MB | ~22% |
  | 1,000 games/day | ~1.5 M | ~1.6 M | ~240 MB | ~48% |

  Without pruning these grow linearly forever; with the 13-month prune the
  resident set is **capped** at the values above regardless of how many years the
  app runs. Even sustained 1,000 games/day stays under half the cap in
  perpetuity, leaving room for `games`, `player_stats`, and index/WAL overhead.
- This is a preventive bound, not an urgent fix: at hobby traffic the table is a
  few MB. The prune exists so the unbounded table can never silently approach the
  cap years out.

---

## Test Requirements

Per testing-principles: deterministic, self-contained, run the real SQL (no
mocks of migrations). This LLD has **no TypeScript unit surface** (no backend
code changes); testing is integration + gate + post-condition.

### Integration (against `supabase start` + prod-shaped fixture)

- **Prune deletes only aged rows, keeps the rest.** Seed `game_history` (direct
  state insertion) with rows at known `played_at`: some `< now() − 13 months`,
  some just inside the floor (e.g. 12 months, 30 days, today). Call
  `SELECT prune_game_history();`. Assert only the >13-month rows are gone and all
  rows inside the floor remain. Cover the boundary: a row at exactly
  `now() − 13 months` is **retained** (`<` is strict).
- **Window-safety invariant (E2).** Seed a YTD-edge row (Jan 1 of the current
  year) and a 30d-edge row; run the prune; assert `get_windowed_stats(user,
  <ytd cutoff>)` and `get_windowed_stats(user, <30d cutoff>)` return the same
  counts before and after — the prune never removes a row any window reads.
- **Idempotency (E3).** Run the prune twice back-to-back; second run deletes 0
  rows and the table state is identical. Re-apply migration 011 (re-run
  `cron.schedule`) and assert exactly one `prune-game-history` job exists in
  `cron.job` (no duplicate).
- **`player_stats` untouched (E1) — the headline check.** Seed `player_stats`
  rows and `game_history` rows (including >13-month rows). Snapshot the
  `player_stats` aggregate. Run the prune. Assert `player_stats` is byte-for-byte
  unchanged (this is also the post-condition assertion; verify it here against a
  DB that actually has aged rows to delete, which the fresh-CI post-condition
  cannot).
- **Migration + post-condition coverage.** Apply 011 via the post-condition
  runner; assert `prune_game_history` exists, is `SECURITY DEFINER`, grant set is
  service_role-only; assert the runner's 1:1 coverage passes. Where pg_cron is
  present, assert the `prune-game-history` job is registered; where absent, assert
  the migration still applied (function present, scheduling skipped, coverage
  green — E4).

### Gate

- **Destructive-DDL gate.** `npm run verify:no-destructive-ddl` passes with the
  `"011_prune_game_history.sql": ["DELETE"]` allowlist entry present, and **fails**
  if the entry is removed (proves the single in-body `DELETE` is genuinely gated
  and the allowlist is load-bearing). Assert exactly one `DELETE` op is reported
  for the file (the scheduled-command string literal is neutralized and does not
  count).
- **Drift gate.** `npm run verify:drift -- --diff-file scripts/fixtures/clean-diff.json`
  passes with `011_*` in both `expectedPending` and fixture `pending`; assert it
  **fails** if only one is updated (stale-allowlist regression — guards the
  PR #107 footgun).

### Security

- **No anon/authenticated/PUBLIC execute on `prune_game_history`** — post-condition
  asserts the REVOKE/GRANT set (mirror 003). A non-privileged role must not be
  able to trigger a mass delete.
- **Scoped blast radius** — the function's only DML is the single
  `DELETE FROM game_history … 13 months`; no dynamic SQL, no other table
  referenced. Reviewed statically (the destructive-DDL scanner reports exactly
  one `DELETE` for the file and nothing else destructive).

### Out of scope for automated tests

- Live-prod `db push`, the prod-side post-condition run (pooler +
  `PGSSLMODE=no-verify`), and enabling Supabase Cron on the prod project —
  human-owned release steps (LLD 77 §9, DEVELOPMENT.md).
- Long-horizon behavior of pg_cron scheduling itself (a platform responsibility;
  testing-principles §Decision Heuristics #4 — don't test framework behavior).
