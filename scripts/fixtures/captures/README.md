# Real prod capture (2026-07-04)

Verbatim, read-only output captured from the live prod Supabase project to
finalize the linked-prod drift adapter (LLD 77a, issue #91). Ground truth for
the classifier regexes and version-key mapping. Do NOT trust a `--linked` run
until the adapter is reconciled against these.

- `prod-db-diff.txt`      — `supabase db diff --linked --schema public`
- `prod-migration-list.txt` — `supabase migration list --linked`

Direction of `db diff`: shadow-DB(from migrations) -> prod. "drop X" means prod
is MISSING X. The whole game_history cluster is absent (migration 010 pending).
migration list: Remote blank for 010 = pending; 001-009 applied.
