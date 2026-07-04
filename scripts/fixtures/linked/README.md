# Linked-prod adapter fixtures (LLD 77a §7.1, issue #91)

Raw CLI stdout fixtures for the pure `adaptLinkedDiff` parser
(`scripts/lib/linked-diff-adapter.mjs`). Tested credential-free — the parser
turns these into `{ objects, expectedFromPending, pending }` and the result is
fed into the real `evaluateDriftGate` with no prod access.

Files marked **(REAL)** are copied/derived from the verbatim prod capture in
`scripts/fixtures/captures/` (2026-07-04) — they are ground truth, not
provisional. The others are hand-authored to exercise a specific path.

## db diff (`supabase db diff --linked --schema public`)

Direction (confirmed by the capture): shadow-DB(from migrations) → prod. A
`drop`/`revoke` = prod is MISSING that object; a `create`/`grant` = prod has an
object the migrations don't (residual).

- `db-diff.pending-010.txt` **(REAL, PRE-010 world)** — the whole `game_history`
  cluster (table + 2 indexes + pkey constraint + 15 revokes + `get_windowed_stats`)
  as drops/revokes because migration `010` is pending, plus `increment_player_stats`
  re-emitted as `CREATE OR REPLACE` (the lone genuine residual — cosmetic
  diff-engine noise). NB: `009` (game_config) does NOT appear — it is applied to
  prod, so only `010` is pending. NOTE: this pairs with an inline 010-pending
  allowlist, NOT the shipped one (which is reconciled to the POST-010 world below).
- `db-diff.posto10-pending-011.txt` **(REAL, POST-010 world — LLD 011)** — derived
  from `scripts/fixtures/captures/prod-db-diff-posto10.txt`: `010` applied, `011`
  pending. The six `game_history` stray write grants (G6:
  `grant {insert,update,delete} on game_history to {anon,authenticated}`) as
  `direction:add` residual (the TypeORM-era default-privilege drift `011` REVOKEs,
  acknowledged #176), plus the cosmetic `increment_player_stats` re-emission (#91).
  Also carries the combined 011-run reality: `alter table … enable row level
  security` + `create policy … as permissive for select …` (shadow-from-migrations
  has RLS, prod doesn't yet). Those two `direction:"drop"` lines self-attribute to
  pending `011` (77b raw-text scan) and drop as benign — the `as permissive` clause
  makes the classifier default the policy cmd to `ALL` (`policy:public:game_history:ALL`),
  so they never reach the residual and the verdict is unchanged (residual = G6 +
  `increment_player_stats`). Pairs with the SHIPPED allowlist.
- `db-diff.clean.txt` — the exact `No schema changes found` sentinel amid noise.
- `db-diff.residual-drift.txt` — SYNTHETIC "genuine unexpected drift": a
  `player_stats_pkey1` constraint + stray `anon` INSERT grant on `player_stats`
  (the T1 class, raw form of `drifted-diff.json`). Not attributable to any pending
  migration, not acknowledged → gate FAILS.
- `db-diff.unclassifiable.txt` — a statement the classifier does not (and should
  not) recognize (`create trigger ... execute function moddatetime()`) → THROW
  (F3). (Was `... enable row level security`, now CLASSIFIED per LLD 77b, so the
  fixture was repurposed to a genuinely-unclassifiable statement.)
- `db-diff.rls-pending-attributed.txt` **(LLD 77b)** — `enable row level security`
  + `create policy ... for select` on `game_history`. In the 011 scenario
  (`game_history` created by applied 010, RLS/policy added by pending 011) both
  attribute to pending 011 via `pending.rlsTables` → dropped as benign, no residual.
- `db-diff.rls-residual.txt` **(LLD 77b)** — `enable row level security` +
  `create policy ...` on a table NO pending migration touches → unattributed →
  surface as residual `rls:*` / `policy:*` (real drift, Edge Cases 2 & 4).
- `db-diff.empty-not-sentinel.txt` — zero DDL but NOT the sentinel → THROW (F4).

## migration list (`supabase migration list --linked`)

Version key = the numeric prefix (`001`..`010`) the CLI prints in the
`Local | Remote | Time` table. Blank Remote = pending. "Skipping migration ..."
warnings for the `.json` allowlist files are ignored.

- `migration-list.pending-010.txt` **(REAL, PRE-010 world)** — `001`-`009`
  applied; `010` pending (blank Remote).
- `migration-list.posto10-pending-011.txt` **(REAL, POST-010 world — LLD 011)** —
  `001`-`010` applied; `011` pending (blank Remote).
- `migration-list.all-applied.txt` — every migration in both columns → no pending.
- `migration-list.unmappable.txt` — a pending key (`999`) with no in-tree file
  → THROW (F5).
- `migration-list.malformed.txt` — no parseable data rows → THROW (F6).
