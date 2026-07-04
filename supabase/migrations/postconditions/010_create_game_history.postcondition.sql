-- Post-condition for 010 (LLD 77 §6, LLD 101): game_history exists with the
-- expected columns + types, the cleaned grant set (anon SELECT-only, no write
-- DML; service_role full), get_windowed_stats is the single 2-arg overload
-- callable by service_role only, and (LLD 011 backfill) RLS is ENABLED with a
-- SELECT-own-rows policy.
--
-- CUMULATIVE-STATE CAVEAT (LLD 011): 010 itself does NOT enable RLS -- 011 does.
-- The RLS assertion below is a BACKFILL landed in the SAME PR as 011. Every
-- post-condition runs against a DB where ALL migrations (including 011) have been
-- applied (the runner runs post-conditions after db push / supabase start), so
-- 011's RLS is present when 010's post-condition runs. This asserts the
-- CUMULATIVE post-011 end state, not something 010 alone produces. The reason this
-- exposure shipped is precisely that 010's post-condition asserted the grant set
-- but not RLS-enabled, so the missing RLS slipped through the gate; the backfill
-- means the class cannot silently regress even if 011 is ever reverted.
--
-- Shape-based / name-agnostic (LLD 77 §6.2 #2): asserts column presence + type
-- and the effective privilege set, NEVER a constraint/PK/index name. game_history
-- is a brand-new table so it is immune to the TypeORM-era *_pkey1 drift, but the
-- column, grant, and RPC assertions must still hold against the prod-shaped
-- baseline. Idempotent and read-only. Resolves objects via search_path.
DO $$
DECLARE
  col record;
  expected_cols CONSTANT text[][] := ARRAY[
    ARRAY['id', 'uuid'],
    ARRAY['user_id', 'uuid'],
    ARRAY['game_type', 'character varying(50)'],
    ARRAY['won', 'boolean'],
    ARRAY['lost', 'boolean'],
    ARRAY['score', 'integer'],
    ARRAY['played_at', 'timestamp with time zone']
  ];
  pair text[];
  found_type text;
  bad_cols text[] := ARRAY[]::text[];
  bad_grants text[] := ARRAY[]::text[];
  write_priv text;
  fn_count int;
  nargs int;
BEGIN
  -- 1. Table presence.
  IF to_regclass('game_history') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (010): table game_history is missing.';
  END IF;

  -- 2. Every expected column is present with the expected type.
  FOREACH pair SLICE 1 IN ARRAY expected_cols LOOP
    SELECT format_type(att.atttypid, att.atttypmod)
      INTO found_type
    FROM pg_attribute att
    WHERE att.attrelid = to_regclass('game_history')
      AND att.attname = pair[1]
      AND NOT att.attisdropped;

    IF found_type IS NULL THEN
      bad_cols := array_append(bad_cols, pair[1] || ':missing');
    ELSIF found_type <> pair[2] THEN
      bad_cols := array_append(bad_cols, pair[1] || ':' || found_type || ' (expected ' || pair[2] || ')');
    END IF;
  END LOOP;

  IF array_length(bad_cols, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): game_history column shape is wrong: %.', bad_cols;
  END IF;

  -- 3. Grant set: service_role full (INSERT/SELECT/UPDATE/DELETE); anon and
  --    authenticated SELECT-only (no write DML).
  IF NOT (
    has_table_privilege('service_role', to_regclass('game_history'), 'SELECT') AND
    has_table_privilege('service_role', to_regclass('game_history'), 'INSERT') AND
    has_table_privilege('service_role', to_regclass('game_history'), 'UPDATE') AND
    has_table_privilege('service_role', to_regclass('game_history'), 'DELETE')
  ) THEN
    bad_grants := array_append(bad_grants, 'service_role:missing full access');
  END IF;

  FOREACH write_priv IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT has_table_privilege(write_priv, to_regclass('game_history'), 'SELECT') THEN
      bad_grants := array_append(bad_grants, write_priv || ':missing SELECT');
    END IF;
  END LOOP;

  FOREACH write_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', to_regclass('game_history'), write_priv) THEN
      bad_grants := array_append(bad_grants, 'anon:stray ' || write_priv);
    END IF;
    IF has_table_privilege('authenticated', to_regclass('game_history'), write_priv) THEN
      bad_grants := array_append(bad_grants, 'authenticated:stray ' || write_priv);
    END IF;
  END LOOP;

  IF array_length(bad_grants, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): game_history grant set is wrong: %. Expected service_role full, anon/authenticated SELECT-only.',
      bad_grants;
  END IF;

  -- 4. get_windowed_stats is exactly one visible 2-arg overload.
  SELECT count(*) INTO fn_count
  FROM pg_proc
  WHERE proname = 'get_windowed_stats' AND pg_function_is_visible(oid);

  IF fn_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): expected exactly 1 visible get_windowed_stats overload, found %.',
      fn_count;
  END IF;

  SELECT pronargs INTO nargs
  FROM pg_proc
  WHERE proname = 'get_windowed_stats' AND pg_function_is_visible(oid);

  IF nargs <> 2 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): get_windowed_stats has % argument(s), expected 2 (p_user_id, p_since).',
      nargs;
  END IF;

  -- 5. get_windowed_stats is callable by service_role only (not PUBLIC/anon/authenticated).
  IF NOT has_function_privilege(
        'service_role',
        (SELECT oid FROM pg_proc WHERE proname = 'get_windowed_stats' AND pg_function_is_visible(oid)),
        'EXECUTE') THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): service_role cannot EXECUTE get_windowed_stats.';
  END IF;

  IF has_function_privilege(
        'anon',
        (SELECT oid FROM pg_proc WHERE proname = 'get_windowed_stats' AND pg_function_is_visible(oid)),
        'EXECUTE')
     OR has_function_privilege(
        'authenticated',
        (SELECT oid FROM pg_proc WHERE proname = 'get_windowed_stats' AND pg_function_is_visible(oid)),
        'EXECUTE') THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): get_windowed_stats is executable by anon/authenticated; expected service_role-only.';
  END IF;

  -- 6. RLS backfill (LLD 011, cumulative post-011 state): RLS is ENABLED and a
  --    SELECT-own-rows policy exists. Asserts the class 010's post-condition
  --    originally missed. Shape-based (relrowsecurity + cmd='SELECT'), name-agnostic.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass('game_history') AND relrowsecurity
  ) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): RLS is not enabled on game_history (expected after 011).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'game_history'
      AND cmd = 'SELECT'
      AND qual ILIKE '%user_id%'
  ) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (010): game_history has no SELECT-own-rows policy (cmd=SELECT, qual references user_id; expected after 011).';
  END IF;
END $$;
