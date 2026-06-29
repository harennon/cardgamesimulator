-- Post-condition for 001 (LLD 77 §6): the three core tables exist, and anon's
-- privileges on them are EXACTLY SELECT (no INSERT/UPDATE/DELETE). 001 grants
-- anon only SELECT; the stray anon write grants on prod are TypeORM-era residue
-- (the surface #83 removes), so this asserts the intended cleaned end-state.
--
-- Name-agnostic / shape-based: asserts table presence and the anon grant set,
-- never a constraint name. Idempotent and read-only. Resolves table names via
-- search_path (correct on drifted prod, clean CI, and the prod-shaped fixture).
DO $$
DECLARE
  tbl text;
  missing text[] := ARRAY[]::text[];
  bad_grants text[] := ARRAY[]::text[];
  write_priv text;
BEGIN
  -- 1. Every core table is present in the current search_path.
  FOREACH tbl IN ARRAY ARRAY['games', 'player_stats', 'feedback'] LOOP
    IF to_regclass(tbl) IS NULL THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (001): missing table(s) %, expected games, player_stats, feedback.',
      missing;
  END IF;

  -- 2. anon must hold SELECT and NONE of INSERT/UPDATE/DELETE on each table.
  FOREACH tbl IN ARRAY ARRAY['games', 'player_stats', 'feedback'] LOOP
    IF NOT has_table_privilege('anon', to_regclass(tbl), 'SELECT') THEN
      bad_grants := array_append(bad_grants, tbl || ':missing SELECT');
    END IF;
    FOREACH write_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('anon', to_regclass(tbl), write_priv) THEN
        bad_grants := array_append(bad_grants, tbl || ':stray ' || write_priv);
      END IF;
    END LOOP;
  END LOOP;

  IF array_length(bad_grants, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (001): anon grant set is wrong: %. Expected SELECT-only on games, player_stats, feedback.',
      bad_grants;
  END IF;
END $$;
