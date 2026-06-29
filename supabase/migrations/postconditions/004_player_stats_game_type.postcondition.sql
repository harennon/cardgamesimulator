-- Post-condition for 004/006 (LLD 77 §6.2): player_stats has a game_type column
-- and its PRIMARY KEY is EXACTLY the composite (user_id, game_type).
--
-- Name-agnostic (asserts shape, never a constraint name) so it holds on prod
-- (where 004 hardcoded a wrong drop name and 006 repaired it) and on fresh CI
-- alike. This is the leg that would have caught the LLD 66 incident at test
-- time. Idempotent and read-only. Resolves player_stats via search_path.
DO $$
DECLARE
  cols text[];
BEGIN
  -- 1. The game_type column is present.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('player_stats')
      AND attname = 'game_type'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (004): player_stats.game_type column is missing.';
  END IF;

  -- 2. The PK is EXACTLY the composite (user_id, game_type). attname is sorted
  --    so PK column order does not matter.
  SELECT array_agg(att.attname::text ORDER BY att.attname::text)
    INTO cols
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS k ON true
  JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k
  WHERE c.conrelid = to_regclass('player_stats') AND c.contype = 'p';

  IF cols IS DISTINCT FROM ARRAY['game_type', 'user_id'] THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (004/006): player_stats PK is %, expected composite (user_id, game_type).',
      cols;
  END IF;
END $$;
