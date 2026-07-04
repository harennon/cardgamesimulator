-- Post-condition for 011 (LLD 149): prune_game_history() exists, is SECURITY
-- DEFINER, EXECUTE is granted to service_role and REVOKEd from anon/authenticated/
-- PUBLIC; the cron job is registered (when pg_cron is present); and a prune run
-- does NOT change player_stats aggregates (acceptance criterion, machine-checked).
--
-- Shape-based / name-agnostic (LLD 77 §6.2 #2): asserts function presence +
-- security flag + grant set, never a constraint/index name. Idempotent.
-- The cron-job assertion is self-guarded so it never errors where pg_cron is
-- absent (e.g. bare supabase start). Assertion 3 invokes prune_game_history()
-- and then verifies player_stats is unchanged. The function only ever touches
-- game_history (never player_stats), so the check is structurally safe; on both
-- CI/fresh and prod the first verification run deletes 0 game_history rows (the
-- table has no rows older than 13 months at this stage), making the invocation
-- a true no-op for data purposes.

DO $$
DECLARE
  fn_count int;
  is_secdef boolean;
  service_can boolean;
  anon_can boolean;
  authd_can boolean;
  public_can boolean;
  fn_oid oid;
BEGIN
  -- 1. prune_game_history is exactly one visible function.
  SELECT count(*) INTO fn_count
  FROM pg_proc
  WHERE proname = 'prune_game_history' AND pg_function_is_visible(oid);

  IF fn_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (011): expected exactly 1 visible prune_game_history function, found %.',
      fn_count;
  END IF;

  SELECT oid, prosecdef INTO fn_oid, is_secdef
  FROM pg_proc
  WHERE proname = 'prune_game_history' AND pg_function_is_visible(oid);

  -- 1a. Must be SECURITY DEFINER.
  IF NOT is_secdef THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (011): prune_game_history must be SECURITY DEFINER.';
  END IF;

  -- 1b. Grant set: service_role EXECUTE; anon/authenticated/PUBLIC REVOKEd.
  service_can := has_function_privilege('service_role', fn_oid, 'EXECUTE');
  anon_can    := has_function_privilege('anon', fn_oid, 'EXECUTE');
  authd_can   := has_function_privilege('authenticated', fn_oid, 'EXECUTE');
  public_can  := has_function_privilege('public', fn_oid, 'EXECUTE');

  IF NOT service_can THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (011): service_role must have EXECUTE on prune_game_history.';
  END IF;

  IF anon_can OR authd_can OR public_can THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (011): EXECUTE on prune_game_history must be REVOKED from anon/authenticated/PUBLIC (anon=%, authenticated=%, public=%).',
      anon_can, authd_can, public_can;
  END IF;
END $$;

-- 2. Cron job is registered (only when pg_cron is present; skip silently otherwise).
-- Guard via plpgsql DO block: a bare SELECT ... FROM cron.job at the top level
-- would raise "schema cron does not exist" on a bare supabase start and fail
-- coverage. The SELECT is placed inside the IF EXISTS branch so it is only
-- executed when the schema actually exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'prune-game-history'
    ) THEN
      RAISE EXCEPTION
        'POSTCONDITION FAILED (011): cron job "prune-game-history" is not registered in cron.job.';
    END IF;
  END IF;
END $$;

-- 3. player_stats is unchanged after a prune invocation (acceptance criterion).
-- Snapshots player_stats row count + aggregate hash (shape-agnostic so this
-- assertion holds regardless of which migrations have been applied before 011),
-- calls prune_game_history(), then re-snapshots and asserts equality.
-- prune_game_history() references only game_history — never player_stats — so
-- both the row count and the row hash must be identical before and after.
DO $$
DECLARE
  before_count bigint;
  after_count  bigint;
  before_hash  text;
  after_hash   text;
BEGIN
  SELECT count(*) INTO before_count FROM player_stats;
  SELECT coalesce(md5(string_agg(player_stats::text, ',' ORDER BY user_id)), '')
    INTO before_hash FROM player_stats;

  PERFORM prune_game_history();

  SELECT count(*) INTO after_count FROM player_stats;
  SELECT coalesce(md5(string_agg(player_stats::text, ',' ORDER BY user_id)), '')
    INTO after_hash FROM player_stats;

  IF before_count <> after_count OR before_hash IS DISTINCT FROM after_hash THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (011): prune_game_history() changed player_stats — this must never happen. rows before=%, after=%; hash before=%, after=%',
      before_count, after_count, before_hash, after_hash;
  END IF;
END $$;
