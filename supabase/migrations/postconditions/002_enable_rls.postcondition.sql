-- Post-condition for 002 (LLD 77 §6): row-level security is ENABLED on all
-- three core tables. Shape-based (asserts relrowsecurity, never a policy name),
-- idempotent, read-only. Resolves table names via search_path.
DO $$
DECLARE
  tbl text;
  not_enabled text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY ARRAY['games', 'player_stats', 'feedback'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = to_regclass(tbl) AND relrowsecurity
    ) THEN
      not_enabled := array_append(not_enabled, tbl);
    END IF;
  END LOOP;

  IF array_length(not_enabled, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (002): RLS not enabled on %, expected RLS on games, player_stats, feedback.',
      not_enabled;
  END IF;
END $$;
