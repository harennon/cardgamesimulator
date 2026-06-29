-- Post-condition for 006 (LLD 77 §6): the player_stats PK is the composite
-- (user_id, game_type) AND the TypeORM-era drift name 'player_stats_pkey1' no
-- longer exists on the table. 006's job is to repair the PK that 004 failed to
-- apply on prod (where it was named *_pkey1) and re-add it conventionally; this
-- asserts both that the composite shape is in place and that the drift artifact
-- is gone.
--
-- The shape assertion (composite PK) is name-agnostic; the absence check targets
-- the SPECIFIC drift artifact 006 removes, not a "good" name, so it holds on
-- fresh CI (which never had *_pkey1) too. Idempotent and read-only.
DO $$
DECLARE
  cols text[];
BEGIN
  -- 1. PK is exactly the composite (user_id, game_type).
  SELECT array_agg(att.attname::text ORDER BY att.attname::text)
    INTO cols
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS k ON true
  JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k
  WHERE c.conrelid = to_regclass('player_stats') AND c.contype = 'p';

  IF cols IS DISTINCT FROM ARRAY['game_type', 'user_id'] THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (006): player_stats PK is %, expected composite (user_id, game_type).',
      cols;
  END IF;

  -- 2. The TypeORM-era drift constraint name must be gone.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('player_stats')
      AND conname = 'player_stats_pkey1'
  ) THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (006): the TypeORM-era constraint player_stats_pkey1 still exists; 006 should have repaired it.';
  END IF;
END $$;
