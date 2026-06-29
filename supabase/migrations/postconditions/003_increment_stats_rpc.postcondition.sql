-- Post-condition for 003 (LLD 77 §6): the increment_player_stats RPC exists,
-- is SECURITY DEFINER, and EXECUTE is granted to service_role but NOT to
-- anon/authenticated/PUBLIC. This is the security invariant 003 establishes and
-- 005 must preserve (005 drops & recreates the function, which does NOT inherit
-- grants, so it repeats the REVOKE/GRANT block). Asserting the invariant here
-- means it holds after the full applied set (003 superseded by 005).
--
-- Shape-based (function name + security flag + grant set, never an arg list —
-- the arity is 005's post-condition), idempotent, read-only. The function is
-- located via pg_function_is_visible so the lookup respects search_path (the
-- function analog of to_regclass) — correct in a throwaway-schema fixture and
-- against public on prod/CI alike, never double-counting overloads in other
-- schemas.
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
  SELECT count(*) INTO fn_count
  FROM pg_proc
  WHERE proname = 'increment_player_stats' AND pg_function_is_visible(oid);

  IF fn_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (003): expected exactly 1 visible increment_player_stats function, found %.',
      fn_count;
  END IF;

  SELECT oid, prosecdef INTO fn_oid, is_secdef
  FROM pg_proc
  WHERE proname = 'increment_player_stats' AND pg_function_is_visible(oid);

  IF NOT is_secdef THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (003): increment_player_stats must be SECURITY DEFINER.';
  END IF;

  service_can := has_function_privilege('service_role', fn_oid, 'EXECUTE');
  anon_can := has_function_privilege('anon', fn_oid, 'EXECUTE');
  authd_can := has_function_privilege('authenticated', fn_oid, 'EXECUTE');
  public_can := has_function_privilege('public', fn_oid, 'EXECUTE');

  IF NOT service_can THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (003): service_role must have EXECUTE on increment_player_stats.';
  END IF;

  IF anon_can OR authd_can OR public_can THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (003): EXECUTE on increment_player_stats must be REVOKED from anon/authenticated/PUBLIC (anon=%, authenticated=%, public=%).',
      anon_can, authd_can, public_can;
  END IF;
END $$;
