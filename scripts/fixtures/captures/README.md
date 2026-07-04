# Real prod capture (2026-07-04)

Verbatim, read-only output captured from the live prod Supabase project to
finalize the linked-prod drift adapter (LLD 77a, issue #91). Ground truth for
the classifier regexes and version-key mapping. Do NOT trust a `--linked` run
until the adapter is reconciled against these.

Direction of `db diff`: shadow-DB(from migrations) -> prod. "drop X" means prod
is MISSING X.

## Capture 1 — PRE-010 (010 pending, game_history absent)
- `prod-db-diff.txt`      — `supabase db diff --linked --schema public`
- `prod-migration-list.txt` — `supabase migration list --linked`

The whole game_history cluster shows as drop/revoke (prod MISSING it, migration
010 pending). migration list: Remote blank for 010 = pending; 001-009 applied.

## Capture 2 — POST-010 (010 applied; basis for LLD 011)
- `prod-db-diff-posto10.txt`      — `supabase db diff --linked` (full-DB, see note)
- `prod-migration-list-posto10.txt` — `supabase migration list --linked`

After the first prod-migrate run applied 010. migration list: Remote=010, nothing
pending (001-010 all applied). The db diff shows the six stray write grants
(`grant {insert,update,delete} on game_history to {anon,authenticated}`) as
direction:"add" residual — the TypeORM-era default-privilege drift LLD 011 fixes —
plus the cosmetic increment_player_stats re-emission (already acknowledged).

NOTE: this diff was run WITHOUT `--schema public`, so its raw output also contained
`drop extension if exists "pg_net"` (local-shadow has pg_net, prod doesn't — benign
extension noise). That line is STRIPPED from the saved fixture because the gate runs
`--schema public` and never sees extension-level diffs (confirmed: the live gate run
28699875349 and Capture 1's --schema-public diff show no pg_net). The saved file
reflects the public-schema content the gate actually evaluates.
