-- Post-condition for 005 (LLD 77 §6): increment_player_stats is the 6-arg,
-- game-type-aware signature, and the old 5-arg overload no longer exists. This
-- is the runtime contract 005's RPC relies on (the composite ON CONFLICT
-- target). Asserting arity (pronargs = 6) and uniqueness (exactly one overload)
-- catches the "two overloads coexist" / "stale 5-arg still callable" hazard
-- (LLD 66 §3.2) at apply time.
--
-- Shape-based (arg count, never a name), idempotent, read-only. Located via
-- pg_function_is_visible so the lookup respects search_path (the function analog
-- of to_regclass) — correct in a throwaway-schema fixture and against public on
-- prod/CI alike, never double-counting overloads in other schemas.
DO $$
DECLARE
  fn_count int;
  nargs int;
BEGIN
  SELECT count(*) INTO fn_count
  FROM pg_proc
  WHERE proname = 'increment_player_stats' AND pg_function_is_visible(oid);

  IF fn_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (005): expected exactly 1 visible increment_player_stats overload, found % (the 5-arg overload must be dropped).',
      fn_count;
  END IF;

  SELECT pronargs INTO nargs
  FROM pg_proc
  WHERE proname = 'increment_player_stats' AND pg_function_is_visible(oid);

  IF nargs <> 6 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (005): increment_player_stats has % argument(s), expected 6 (game-type-aware signature).',
      nargs;
  END IF;
END $$;
