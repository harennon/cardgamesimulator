# LLD 75: Clean up prod schema drift — TypeORM-era PK names (games_pkey1/feedback_pkey1) + stray anon write grants

## Scope

**Covers:** Two forward SQL migrations that bring prod's `public` schema back in line with the committed migrations, fixing drift inherited from the pre-Supabase TypeORM era:

1. **PK name normalization** — rename the primary-key constraints on `games` and `feedback` from their prod-only `*_pkey1` names to the conventional `games_pkey` / `feedback_pkey`, using a name-agnostic catalog lookup (never a hardcoded old name).
2. **Anon grant hygiene** — `REVOKE INSERT, UPDATE, DELETE ON games, player_stats, feedback FROM anon` so the grants match `001`'s declared SELECT-only intent.

Both are idempotent and a verified no-op on fresh local/CI databases (where `supabase start` already produces the conventional names and SELECT-only anon grants).

**Does NOT cover:**
- `player_stats`'s PK — already repaired by `006` (PR #81). This LLD touches `player_stats` only for the `anon` REVOKE (which `006` did not address).
- Any change to `service_role` or `authenticated` grants (they already match `001`).
- Any RLS policy change (`002` is correct; the anon writes are already blocked by RLS — the REVOKE is defense-in-depth, not a live-vulnerability fix).
- Automated prod-migration application / a staging environment. The migration is applied to prod by the existing separate human `supabase db push` step. This LLD does NOT wire or hold prod credentials.
- The root-cause prod-vs-CI divergence problem (fresh-CI-DB vs prod-TypeORM-history) — that gap is scoped separately.

## Approach

### Why the drift exists (root cause)
`001_create_tables.sql` uses `CREATE TABLE IF NOT EXISTS`. On prod the tables already existed (created by TypeORM `synchronize`), so `001` was a no-op there and TypeORM's artifacts persisted: PK constraints named `*_pkey1` (the `1` suffix appears when the default `*_pkey` name was already taken at creation time) and the default Supabase role grants (which include INSERT/UPDATE/DELETE for `anon`). Fresh `supabase start` DBs run `001` for real and get clean names + SELECT-only anon grants. Hence the drift is invisible in CI but live on prod.

### Why it matters (and why not to panic)
- **PK names:** functionally harmless today, but any future migration that hardcodes `DROP CONSTRAINT IF EXISTS games_pkey` will silently skip on prod — the exact failure mode that broke `004` on `player_stats` (see `006` header). This is a latent repeat-bug. `ALTER ... RENAME CONSTRAINT` is metadata-only (no table rewrite), so the fix is cheap.
- **Anon grants:** NOT an open door. RLS is enabled (`002`) with no INSERT/UPDATE/DELETE policies on `games`/`player_stats`, and `feedback`'s insert policy requires `auth.uid() = user_id` (null for anon). RLS already blocks every anon write (proven by `rls.test.ts` "Security test 1"). The REVOKE removes unnecessary privilege surface so we are not relying on RLS alone — if a policy is ever loosened, the grant is not waiting to become live.

### Key decisions

1. **Mirror the `006` pattern exactly.** Use a `DO $$ ... $$` block that looks up the current PK constraint by querying `pg_constraint` for the table's primary key (`contype = 'p'`), then `ALTER TABLE ... RENAME CONSTRAINT <actual> TO <conventional>` only when the name differs. Never hardcode the `*_pkey1` name in a DROP/RENAME source — that is the bug class this LLD fixes.

2. **One file or two?** **Recommendation: two separate migration files**, `007_normalize_pk_names.sql` (renames) and `008_revoke_anon_writes.sql` (grants). Rationale: they are independent concerns with independent failure/rollback semantics, and separate files make the prod `db diff` review and any future revert surgical. (Alternative: a single `007` combined file — fewer files, but mixes DDL rename with grant revocation and muddies review. Rejected for clarity.) Numbering continues the existing sequence after `006`.

3. **RENAME over DROP+ADD for the PK.** Renaming preserves the constraint object (and its backing unique index) — no rewrite, no window where the PK is absent, no FK breakage. `006` had to DROP+ADD because it changed the PK *columns*; here only the *name* changes, so a pure rename is correct and strictly safer.

4. **Unqualified table names** so they resolve via `search_path` — required for the throwaway-schema tests to run the real SQL against an isolated schema (consistent with `004`/`006` and `pgClient` test harness).

5. **Idempotent + no-op on clean DBs.** The rename guard (`IF current_name <> 'games_pkey'`) makes re-runs and fresh DBs no-ops. `REVOKE` is inherently idempotent (revoking an absent grant is a no-op and does not error), so `008` is safe on fresh DBs where anon never had those grants.

6. **Confirm no legitimate anon-write dependency before revoking.** All mutations go through the backend `service_role` (architecture principle 1: server-authoritative). `authenticated`/`anon` PostgREST access is read-only by design. Verification is a code/grep check (below), not a runtime gate.

## Interfaces / Types

No TypeScript interfaces, API contracts, or engine types change. This is purely a DB-schema reconciliation. The migration artifacts:

### `supabase/migrations/007_normalize_pk_names.sql`
A header comment (mirroring `006`'s explanatory style: what drifted, why, why name-agnostic) followed by, **per table** in `{games, feedback}`:

```
DO $$
DECLARE pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'games'::regclass AND contype = 'p';

  IF pk_name IS NOT NULL AND pk_name <> 'games_pkey' THEN
    EXECUTE format('ALTER TABLE games RENAME CONSTRAINT %I TO games_pkey', pk_name);
  END IF;
END $$;
```
(and the analogous block for `feedback` → `feedback_pkey`). `player_stats` is intentionally omitted — `006` already named its PK `player_stats_pkey`.

### `supabase/migrations/008_revoke_anon_writes.sql`
A header comment explaining the drift + the "RLS already blocks these; this is defense-in-depth to match 001" rationale, followed by:

```
REVOKE INSERT, UPDATE, DELETE ON games        FROM anon;
REVOKE INSERT, UPDATE, DELETE ON player_stats FROM anon;
REVOKE INSERT, UPDATE, DELETE ON feedback     FROM anon;
```
`SELECT` for `anon` is left intact (matches `001` lines 54-56).

## State Model

No application state, no in-memory state, no game state. Postgres catalog (`pg_constraint`) and role grant (`pg_class.relacl`) metadata only.

- **Persisted:** the renamed constraint names and the revoked grants live in the prod Postgres catalog after `supabase db push`.
- **Migration ordering:** `007`, `008` apply in filename order after `006`. On fresh DBs both are no-ops; on prod they perform the one-time correction.
- **No data movement:** `RENAME CONSTRAINT` and `REVOKE` are metadata-only; zero rows read or written, no locks beyond a brief catalog `ACCESS EXCLUSIVE` on the named table (sub-millisecond).
- **Application impact:** none. The backend addresses rows by column, never by constraint name; PostgREST grants for the backend (`service_role`) are unchanged.

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Fresh CI/local DB: PK already named `games_pkey`/`feedback_pkey` | Rename guard `pk_name <> 'games_pkey'` is false → no-op. Verified by a "fresh-like" test asserting the constraint OID is unchanged. |
| 2 | Prod: PK named `games_pkey1`/`feedback_pkey1` | Lookup finds the real name, rename fires → conventional name. Verified by a "prod-like" test. |
| 3 | Migration re-run (idempotency) | After first run the name is already conventional → guard false → no-op. Tests run the SQL twice and assert stability. |
| 4 | Table has no PK at all (`pk_name IS NULL`) | Guard skips (the `IS NOT NULL` clause). Will not happen for `games`/`feedback` (both declare `PRIMARY KEY` in `001`), but defended for safety. |
| 5 | Some unexpected third PK name (neither `*_pkey` nor `*_pkey1`) | Name-agnostic lookup still renames it to the conventional name — that is the point of not hardcoding. |
| 6 | `008` run on a DB where anon never had write grants | `REVOKE` of an absent grant is a silent no-op in Postgres → safe on fresh DBs. |
| 7 | A legitimate path relies on anon writes | None exists (all mutations are `service_role`; PostgREST anon is read-only). Pre-merge verification: grep the codebase for anon-key write calls (`.insert`/`.update`/`.delete` on an anon client) — expect none outside RLS negative tests. If any are found, escalate before merging `008`. |
| 8 | Name collision: `games_pkey` somehow already exists as a *different* constraint when renaming `games_pkey1` | Cannot occur — a table has exactly one primary key; if it were already named `games_pkey` the guard would have skipped. RENAME to an existing constraint name would error loudly (acceptable: signals real corruption, not silent skip). |
| 9 | Applied out of order / `006` not yet applied on prod | Independent of `006`; `007`/`008` touch different constraints/grants. `006` is already shipped (PR #81). |

## Dependencies

- **Existing migrations `001`–`006`** must be applied first (standard sequential ordering). `006` (PR #81) is already in prod.
- **`tests/integration/helpers/pgClient.ts`** (`makePgClient`, `readMigrationSql`) — reused as-is for the throwaway-schema tests. No changes needed.
- **Local Supabase stack** (`supabase start`, port 54322) for running integration tests, per `DEVELOPMENT.md`.
- **Human `supabase db push` step** applies to prod — outside this LLD's automation. No prod credentials are referenced or stored here.
- **Pre-merge verification** (Edge Case 7): grep confirming no anon-key write path. This is a checklist item for the implementer, not code.

## Test Requirements

Follow the `006` throwaway-schema pattern in `tests/integration/player-stats.test.ts` (the `"Migration 006 composite-PK repair"` describe block): each test creates an isolated schema, `SET search_path`, materializes the relevant starting state, runs the **real** migration SQL via `readMigrationSql(...)`, asserts the outcome, then drops the schema in `finally`. Self-contained, no shared state (testing principle 3).

### Integration — `007` PK rename
Add a `describe("Migration 007 PK-name normalization")` block (suggested location: alongside the `006` block, or a new `tests/integration/migration-drift.test.ts`):

1. **prod-like, games** — create `games` with `CONSTRAINT games_pkey1 PRIMARY KEY (game_id)`; run `007`; assert exactly one PK, `conname = 'games_pkey'`, columns unchanged (`PRIMARY KEY (game_id)`), and `games_pkey1` is gone.
2. **prod-like, feedback** — same for `feedback` with `feedback_pkey1` → `feedback_pkey`.
3. **fresh-like, no-op + idempotent** — create both tables with already-conventional PK names; capture each PK's OID; run `007` **twice**; assert the PK name/columns are unchanged AND the OID is identical (proves no drop/recreate), mirroring the `006` fresh-like OID assertion.
4. **no-PK guard** — create a table variant with no primary key (or assert the `IS NOT NULL` branch); run `007`; assert it does not error. (May be folded into test 3 if it complicates the schema setup.)

### Integration — `008` anon REVOKE
Add a `describe("Migration 008 anon write-grant revocation")` block:

5. **prod-like grants removed** — create `games`/`player_stats`/`feedback`, `GRANT INSERT, UPDATE, DELETE ON ... TO anon` (and `GRANT SELECT` to mimic prod), run `008`; assert via `has_table_privilege('anon', '<schema>.<table>', 'INSERT'|'UPDATE'|'DELETE')` returns false for all three tables/privileges, and `SELECT` is still true.
6. **fresh-like no-op** — create the tables with only `GRANT SELECT ... TO anon`; run `008` (twice for idempotency); assert it does not error and `SELECT` remains true, INSERT/UPDATE/DELETE remain false. Note: `has_table_privilege` requires the `anon` role to exist — the local Supabase Postgres has it; if a bare test DB does not, create the role in-schema setup or assert via `relacl` parsing instead.

### Verification (manual, one-time, pre-merge — not automated)
- Run `grep` for anon-key write paths (Edge Case 7) — expect none. Record the result in the PR.
- After human `supabase db push` to prod: run `supabase db diff --linked --schema public` and confirm it reports a clean/empty diff for these PK-name and anon-grant items (acceptance criterion). This is a human prod step, not CI.

### Out of scope for tests
- No engine/unit tests (no game logic touched).
- No new RLS tests — existing `rls.test.ts` already proves anon writes are blocked; `008` does not change that behavior, only the underlying grant.
