-- Post-condition for 011 (LLD 77 §6, LLD 011): game_history is LOCKED DOWN --
-- RLS enabled, a SELECT-own-rows policy present, and the grant set is
-- anon/authenticated SELECT-only (no write DML), service_role full.
--
-- Shape-based / name-agnostic (LLD 77 §6.2 #2): asserts relrowsecurity, the
-- SELECT-command policy shape (cmd='SELECT' + qual references user_id), and the
-- effective privilege set -- NEVER a policy name (a future rename must not
-- falsely fail, and the drift gate is policy-name blind). Idempotent, read-only.
-- Resolves objects via search_path. 011's post-condition fully describes the
-- locked-down end state on its own. Accumulates bad[] and RAISEs once.
DO $$
DECLARE
  bad text[] := ARRAY[]::text[];
  write_priv text;
BEGIN
  -- 1. Table presence (defensive: 011 depends on 010's table).
  IF to_regclass('game_history') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (011): table game_history is missing.';
  END IF;

  -- 2. RLS is ENABLED (the 002 post-condition pattern: relrowsecurity).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass('game_history') AND relrowsecurity
  ) THEN
    bad := array_append(bad, 'rls:not enabled');
  END IF;

  -- 3. A SELECT-own-rows policy exists (by SHAPE, not name): a SELECT-command
  --    policy whose qualifier references user_id. Catches a wrong-shaped policy.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_history'
      AND cmd = 'SELECT'
      AND qual ILIKE '%user_id%'
  ) THEN
    bad := array_append(bad, 'policy:missing SELECT-own-rows (cmd=SELECT, qual references user_id)');
  END IF;

  -- 4. Grant set (same assertion as 010's post-condition): service_role full
  --    (SELECT/INSERT/UPDATE/DELETE); anon and authenticated SELECT-only.
  IF NOT (
    has_table_privilege('service_role', to_regclass('game_history'), 'SELECT') AND
    has_table_privilege('service_role', to_regclass('game_history'), 'INSERT') AND
    has_table_privilege('service_role', to_regclass('game_history'), 'UPDATE') AND
    has_table_privilege('service_role', to_regclass('game_history'), 'DELETE')
  ) THEN
    bad := array_append(bad, 'service_role:missing full access');
  END IF;

  FOREACH write_priv IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT has_table_privilege(write_priv, to_regclass('game_history'), 'SELECT') THEN
      bad := array_append(bad, write_priv || ':missing SELECT');
    END IF;
  END LOOP;

  FOREACH write_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', to_regclass('game_history'), write_priv) THEN
      bad := array_append(bad, 'anon:stray ' || write_priv);
    END IF;
    IF has_table_privilege('authenticated', to_regclass('game_history'), write_priv) THEN
      bad := array_append(bad, 'authenticated:stray ' || write_priv);
    END IF;
  END LOOP;

  IF array_length(bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (011): game_history is not locked down: %. Expected RLS enabled, a SELECT-own-rows policy, anon/authenticated SELECT-only, service_role full.',
      bad;
  END IF;
END $$;
