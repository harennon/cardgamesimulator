-- Post-condition for 008 (LLD 77 §6.2): the `anon` role holds NO write DML
-- (INSERT/UPDATE/DELETE) on games, player_stats, or feedback, while SELECT is
-- left intact -- i.e. anon is read-only on the core tables, matching 001's
-- declared SELECT-only intent. 008 REVOKEs the stray TypeORM-era anon write
-- grants that lived on prod (invisible to fresh CI), so the end-state to assert
-- is the absence of those write privileges.
--
-- Name-agnostic / shape-based (LLD 77 §6.2 #2): asserts the effective privilege
-- set via has_table_privilege, never a grant/policy artifact name. The check is
-- scoped to INSERT/UPDATE/DELETE + SELECT only -- it deliberately ignores
-- REFERENCES/TRIGGER/TRUNCATE, which Supabase's default provisioning may leave on
-- anon and which 008 does not touch -- so it holds on drifted prod, fresh CI, and
-- the throwaway-schema fixture alike. Idempotent and read-only. Resolves table
-- names via search_path (consistent with 001/004/006).
DO $$
DECLARE
  tbl text;
  bad_grants text[] := ARRAY[]::text[];
  write_priv text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['games', 'player_stats', 'feedback'] LOOP
    -- anon must retain SELECT (008 leaves it intact).
    IF NOT has_table_privilege('anon', to_regclass(tbl), 'SELECT') THEN
      bad_grants := array_append(bad_grants, tbl || ':missing SELECT');
    END IF;
    -- anon must hold NONE of INSERT/UPDATE/DELETE (008 revoked them).
    FOREACH write_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('anon', to_regclass(tbl), write_priv) THEN
        bad_grants := array_append(bad_grants, tbl || ':stray ' || write_priv);
      END IF;
    END LOOP;
  END LOOP;

  IF array_length(bad_grants, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (008): anon write grants not revoked: %. Expected SELECT-only (no INSERT/UPDATE/DELETE) on games, player_stats, feedback.',
      bad_grants;
  END IF;
END $$;
