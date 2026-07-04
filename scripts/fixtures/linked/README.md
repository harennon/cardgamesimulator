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

- `db-diff.pending-010.txt` **(REAL)** — the whole `game_history` cluster (table
  + 2 indexes + pkey constraint + 15 revokes + `get_windowed_stats`) as
  drops/revokes because migration `010` is pending, plus `increment_player_stats`
  re-emitted as `CREATE OR REPLACE` (the lone genuine residual — cosmetic
  diff-engine noise, acknowledged in the allowlist). NB: `009` (game_config) does
  NOT appear — it is applied to prod, so only `010` is pending.
- `db-diff.clean.txt` — the exact `No schema changes found` sentinel amid noise.
- `db-diff.residual-drift.txt` — SYNTHETIC "genuine unexpected drift": a
  `player_stats_pkey1` constraint + stray `anon` INSERT grant on `player_stats`
  (the T1 class, raw form of `drifted-diff.json`). Not attributable to any pending
  migration, not acknowledged → gate FAILS.
- `db-diff.unclassifiable.txt` — a statement the narrow v1 classifier does not
  recognize (`... enable row level security`) → THROW (F3).
- `db-diff.empty-not-sentinel.txt` — zero DDL but NOT the sentinel → THROW (F4).

## migration list (`supabase migration list --linked`)

Version key = the numeric prefix (`001`..`010`) the CLI prints in the
`Local | Remote | Time` table. Blank Remote = pending. "Skipping migration ..."
warnings for the `.json` allowlist files are ignored.

- `migration-list.pending-010.txt` **(REAL)** — `001`-`009` applied; `010`
  pending (blank Remote).
- `migration-list.all-applied.txt` — every migration in both columns → no pending.
- `migration-list.unmappable.txt` — a pending key (`999`) with no in-tree file
  → THROW (F5).
- `migration-list.malformed.txt` — no parseable data rows → THROW (F6).
